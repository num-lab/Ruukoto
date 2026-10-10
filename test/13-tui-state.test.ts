/**
 * TUI 视图状态与终端安全（issue 04 §3/§5 的显示侧）。
 *
 * 覆盖：快照安装与实例变更、按消息身份更新流式正文、最终正文沿用展示条目、
 * replay 不回滚状态、历史窗口截断与翻页游标自愈、工具记录与落盘条目去重；
 * sanitizeForDisplay 对擦屏/光标控制/OSC 52/伪造界面/不可见字符的处理。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandHistoryStore } from "@ruukoto/tui/tui/command-history.ts";
import { ViewState, MAX_LOADED_ENTRIES, accessModeLabel, accessModeStyle, formatAccessMode, type SessionView } from "@ruukoto/tui/tui/state.ts";
import { sanitizeForDisplay } from "@ruukoto/tui/tui/sanitize.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { PersistentEvent, Task } from "@ruukoto/core/types.ts";
import type { HistoryEntryView, HistoryPage } from "@ruukoto/core/history.ts";

const messages = (view: SessionView) => view.flow.items.filter((entry) => entry.kind === "message");
const notes = (view: SessionView) => view.flow.items.filter((entry) => entry.kind === "note");

function snapshot(overrides: Partial<ConnectResult["snapshot"]> = {}): ConnectResult["snapshot"] {
  return {
    projects: [{ id: "proj_1", name: "演示", createRequestId: null, rootDir: null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: "2026-09-20T00:00:00Z" }],
    sessions: [
      {
        id: "sess_1",
        projectId: "proj_1",
        workspaceProjectId: null,
        kind: "dev",
        cwd: "/work/a",
        cwdReal: "/work/a",
        cwdDev: 1,
        cwdIno: 1,
        piSessionId: "pi-1",
        sessionFile: null,
        confirmTools: [],
        createRequestId: null,
        modelSelection: { provider: "mock", modelId: "mock-model", thinkingLevel: "off" },
        modelSelectionVersion: 1,
        defaultAccessMode: "confirm",
        defaultAccessModeVersion: 0,
        queueState: "active",
        queuePauseReason: null,
        createdAt: "2026-09-20T00:00:00Z",
      },
    ],
    tasks: [],
    confirmations: [],
    artifacts: [],
    previews: {},
    instanceId: "inst-1",
    execution: { backend: "local", note: "local 执行后端：无隔离" },
    defaultModel: { provider: "mock", id: "mock-model", name: "Mock", thinkingLevel: "off" },
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    sessionId: "sess_1",
    requestId: `req-${id}`,
    input: "输入",
    modelSelection: null,
    submissionDigest: null,
    status: "running",
    accessMode: "confirm",
    planMode: false,
    permissionVersion: 1,
    grantedPaths: [],
    pendingAccessMode: null,
    interruptReason: null,
    cancelRequested: false,
    effectUnknown: false,
    errorMessage: null,
    historyEntryIds: [],
    resumesTaskId: null,
    agentId: null,
    parentTaskId: null,
    sourceEventId: null,
    deadline: null,
    resultSummary: null,
    resultRef: null,
    workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null,
    createdAt: "2026-09-20T00:00:00Z",
    startedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function ev(seq: number, body: PersistentEvent["body"], sessionId: string | null = (body as any).sessionId ?? null): PersistentEvent {
  return { seq, taskId: (body as any).taskId ?? null, sessionId, body, createdAt: "2026-09-20T00:00:00Z" };
}

function histEntry(entryId: string, role: string, text: string, extra: Partial<HistoryEntryView> = {}): HistoryEntryView {
  return {
    entryId,
    parentId: null,
    role,
    timestamp: "2026-09-20T00:00:00Z",
    text,
    offset: 0,
    totalBytes: Buffer.byteLength(text, "utf8"),
    truncated: false,
    toolCalls: [],
    toolCallId: null,
    toolName: null,
    isError: null,
    hasNonTextContent: false,
    ...extra,
  };
}

test("命令历史重同步不重复，超过 50 条仍保留，切换数据实例不串记录", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-command-state-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new CommandHistoryStore(path.join(root, "commands.sqlite"));
  const state = new ViewState(store);
  const connect = (instanceId: string) => ({ seq: 10, replay: [], snapshot: snapshot({ instanceId }) });
  const commands = (state: ViewState) => state.openSession("sess_1").flow.items.filter((entry) => entry.kind === "command");
  state.applySnapshot(connect("first"), false);
  for (let i = 0; i < 60; i++) state.echoCommand("sess_1", `/search ${i}`);
  const original = commands(state);
  assert.equal(original.length, 60);
  state.applySnapshot(connect("first"), false);
  assert.deepEqual(commands(state), original);
  state.applySnapshot(connect("second"), true);
  assert.deepEqual(commands(state), []);
  state.echoCommand("sess_1", "/mode");
  state.applySnapshot(connect("first"), true);
  assert.deepEqual(commands(state), original);

  const recovered = new ViewState(store);
  recovered.applySnapshot(connect("first"), false);
  assert.deepEqual(commands(recovered), original);
  const key = original[0]!.key;
  recovered.setCommandResult("sess_1", key, "查询失败", true);
  state.applySnapshot(connect("first"), false);
  assert.equal(commands(state).find((entry) => entry.key === key)!.result, "查询失败", "重同步应更新其他客户端补写的结果");

  const failedSave = t.mock.method(store, "save", () => { throw new Error("disk full"); });
  state.setCommandResult("sess_1", key, "尚未保存的新结果", true);
  state.applySnapshot(connect("first"), false);
  assert.equal(commands(state).find((entry) => entry.key === key)!.result, "尚未保存的新结果", "保存失败的本地结果不能被旧存储覆盖");
  failedSave.mock.restore();
  state.setCommandResult("sess_1", key, "恢复保存后的结果", true);
  recovered.applySnapshot(connect("first"), false);
  assert.equal(commands(recovered).find((entry) => entry.key === key)!.result, "恢复保存后的结果");
});

test("命令历史读写失败在事件流提示，当前命令仍可显示", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-command-error-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "blocked");
  fs.writeFileSync(file, "保持原内容");
  const state = new ViewState(new CommandHistoryStore(path.join(file, "commands.sqlite")));
  state.applySnapshot({ seq: 10, replay: [], snapshot: snapshot() }, false);
  state.echoCommand("sess_1", "/context");
  const view = state.openSession("sess_1");
  assert.ok(notes(view).some((entry) => entry.text.includes("命令历史读取失败")));
  assert.ok(notes(view).some((entry) => entry.text.includes("命令历史保存失败")));
  assert.ok(view.flow.items.some((entry) => entry.kind === "command" && entry.line === "/context"));
  assert.equal(fs.readFileSync(file, "utf8"), "保持原内容");
});

test("快照安装：项目/会话/任务/预览；实例变更丢弃会话视图", () => {
  const state = new ViewState();
  state.applySnapshot(
    { seq: 10, replay: [], snapshot: snapshot({ tasks: [task("task_1")], previews: { task_1: { messageId: "msg_1", text: "部分输出", totalBytes: 8, truncated: false, seq: 9, state: "generating" } } }) },
    false,
  );
  const view = state.openSession("sess_1");
  const output = messages(view).find((entry) => entry.role === "assistant");
  assert.equal(output?.text, "部分输出");
  assert.equal(output?.streaming, true);
  view.draft = "草稿";
  // 同实例重同步：草稿保留
  state.applySnapshot({ seq: 20, replay: [], snapshot: snapshot() }, false);
  assert.equal(state.openSession("sess_1").draft, "草稿");
  // 实例变更：视图丢弃
  state.applySnapshot({ seq: 5, replay: [], snapshot: snapshot({ instanceId: "inst-2" }) }, true);
  assert.equal(state.sessionViews.size, 0);
  assert.equal(state.instanceId, "inst-2");
});

test("流式正文按消息身份更新；最终引用到达后保留正文，历史补齐沿用同一条目", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 1, replay: [], snapshot: snapshot({ tasks: [task("task_1")] }) }, false);
  state.openSession("sess_1");
  state.applyEvent(ev(2, { type: "task.output_fragment", taskId: "task_1", sessionId: "sess_1", messageId: "msg_1", text: "你好", totalBytes: 6, truncated: false, partial: true }), "live");
  state.applyEvent(ev(3, { type: "task.output_fragment", taskId: "task_1", sessionId: "sess_1", messageId: "msg_1", text: "你好，世界", totalBytes: 15, truncated: false, partial: true }), "live");
  const view = state.openSession("sess_1");
  const current = () => messages(view).find((entry) => entry.text === "你好，世界");
  const key = current()?.key;
  assert.ok(key, "同一消息的片段更新正文而非追加");
  assert.equal(messages(view).filter((entry) => entry.role === "assistant").length, 1);
  // 旧序号片段不得覆盖新预览
  state.applyEvent(ev(2, { type: "task.output_fragment", taskId: "task_1", sessionId: "sess_1", messageId: "msg_1", text: "旧片段", totalBytes: 9, truncated: false, partial: true }), "replay");
  assert.equal(current()?.key, key);
  // 另一消息的补读拥有独立身份，不覆盖当前消息。
  state.applyEvent(ev(2, { type: "task.output_fragment", taskId: "task_1", sessionId: "sess_1", messageId: "msg_0", text: "更早消息", totalBytes: 12, truncated: false, partial: true }), "replay");
  assert.equal(current()?.key, key);
  assert.equal(messages(view).filter((entry) => entry.role === "assistant").length, 2);
  // 引用先到、历史正文尚未读回时，不能清空屏幕上已经显示的正文。
  state.applyEvent(ev(4, { type: "task.output_entry", taskId: "task_1", sessionId: "sess_1", entryId: "e1", sessionFile: "/x.jsonl", role: "assistant", messageId: "msg_1" }), "live");
  assert.equal(current()?.key, key);
  assert.equal(current()?.streaming, true);
  state.appendEntryView("sess_1", histEntry("e1", "assistant", "你好，世界"));
  assert.equal(current()?.key, key);
  assert.equal(current()?.streaming, false);
  assert.equal(messages(view).filter((entry) => entry.entryId === "e1").length, 1);
});

test("replay 不改变任务状态（快照为最新）；live 事件正常驱动", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 10, replay: [], snapshot: snapshot({ tasks: [task("task_1", { status: "completed" })] }) }, false);
  // 补发里包含较旧的 task.started：不得把 completed 回滚
  state.applyEvent(ev(5, { type: "task.started", taskId: "task_1", sessionId: "sess_1" }), "replay");
  assert.equal(state.getTask("task_1")?.status, "completed");
  // live 事件正常驱动状态
  state.openSession("sess_1");
  state.applyEvent(ev(11, { type: "task.interrupted", taskId: "task_1", sessionId: "sess_1", reason: "owner_interrupt", cancelRequested: false, effectUnknown: true }), "live");
  const t = state.getTask("task_1");
  assert.equal(t?.status, "interrupted");
  assert.equal(t?.effectUnknown, true);
  // 中断原因和效果未知属于同一任务终态条目。
  const view = state.openSession("sess_1");
  const ending = view.flow.items.find((entry) => entry.kind === "task");
  assert.ok(ending?.kind === "task" && ending.task.effectUnknown && ending.task.interruptReason === "owner_interrupt");
});

test("历史窗口：加载、向前翻页、条目去重、超限截断后游标自愈", () => {
  const state = new ViewState();
  const page = (ids: string[], nextBefore: string | null): HistoryPage => ({
    fileAvailable: true,
    hasPartialTail: false,
    entries: ids.map((id) => histEntry(id, "user", `消息 ${id}`)),
    nextBefore,
  });
  state.installHistoryPage("sess_1", page(["e5", "e6", "e7"], "e5"), "replace");
  state.installHistoryPage("sess_1", page(["e3", "e4"], "e3"), "prepend");
  // 重复加载同一条目不产生重复
  state.installHistoryPage("sess_1", page(["e3", "e4"], "e3"), "prepend");
  let view = state.openSession("sess_1");
  assert.deepEqual(messages(view).map((i) => i.entryId), ["e3", "e4", "e5", "e6", "e7"]);
  assert.equal(view.historyCursor, "e3");

  // 超限截断：游标指向截断后首条，被丢弃的条目仍可翻页找回
  const many = Array.from({ length: MAX_LOADED_ENTRIES + 20 }, (_, i) => `m${String(i).padStart(4, "0")}`);
  state.installHistoryPage("sess_1", page(many, null), "replace");
  view = state.openSession("sess_1");
  assert.equal(view.flow.historyEntries.length, MAX_LOADED_ENTRIES);
  assert.equal(view.trimmedOlder, true);
  assert.equal(view.historyCursor, "m0020", "截断后游标锚定到窗口首条（其之前的内容可翻页找回）");
});

test("toolResult 落盘后工具条目保持身份与目标，只补齐历史引用", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 1, replay: [], snapshot: snapshot({ tasks: [task("task_1")] }) }, false);
  state.openSession("sess_1");
  state.applyEvent(ev(2, { type: "task.tool_intent", taskId: "task_1", toolOpId: "op_1", sdkCallId: "call_1", toolName: "bash", params: { command: "ls" } }, "sess_1"), "live");
  const flow = state.openSession("sess_1").flow;
  assert.equal(flow.tools.length, 1);
  const key = flow.tools[0]!.key;
  state.applyEvent(ev(3, { type: "task.tool_result", taskId: "task_1", toolOpId: "op_1", summary: "ok", isError: false, artifactIds: [] }, "sess_1"), "live");
  assert.equal(flow.tools[0]!.status, "done");
  state.applyEvent(ev(4, { type: "task.output_entry", taskId: "task_1", sessionId: "sess_1", entryId: "e9", sessionFile: "/session.jsonl", role: "toolResult", messageId: null }, "sess_1"), "live");
  const appended = state.appendEntryView("sess_1", histEntry("e9", "toolResult", "ok", { toolCallId: "call_1", toolName: "bash", isError: false }));
  assert.equal(appended, true);
  assert.equal(flow.tools.length, 1, "实时与历史合并为一个工具条目");
  assert.equal(flow.tools[0]!.key, key);
  assert.equal(flow.tools[0]!.entryId, "e9");
  assert.equal(flow.tools[0]!.target, "ls");
});

// ---------- 终端安全 ----------

test("sanitizeForDisplay：擦屏、光标控制、OSC 52、伪造界面序列被剥离", () => {
  assert.equal(sanitizeForDisplay("正常文本"), "正常文本");
  assert.equal(sanitizeForDisplay("\x1b[2J\x1b[1;1H伪造的界面"), "伪造的界面", "擦屏与光标定位");
  assert.equal(sanitizeForDisplay("\x1b[?25l隐藏光标"), "隐藏光标", "私有模式（上游未覆盖的 CSI 终止符）");
  assert.equal(sanitizeForDisplay("\x1b]52;c;Y2xpcA==\x07写剪贴板"), "写剪贴板", "OSC 52 剪贴板写入");
  assert.equal(sanitizeForDisplay("\x1b]8;;https://evil.example\x07链接\x1b]8;;\x07"), "链接", "OSC 8 链接");
  assert.equal(sanitizeForDisplay("\x1b[31m红色\x1b[0m"), "红色", "SGR 样式");
  assert.equal(sanitizeForDisplay("标题\x1b]0;fake title\x07"), "标题");
  assert.equal(sanitizeForDisplay("APC\x1b_Gi=1;AAAA\x07结束"), "APC结束");
});

test("sanitizeForDisplay：不可见控制字符显示为转义形式；换行与制表保留", () => {
  assert.equal(sanitizeForDisplay("铃声\x07"), "铃声\\x07");
  assert.equal(sanitizeForDisplay("回车\r覆盖"), "回车\\x0d覆盖");
  assert.equal(sanitizeForDisplay("多行\n制表\t保留"), "多行\n制表\t保留");
  assert.equal(sanitizeForDisplay("C1\x85控制"), "C1\\x85控制");
  assert.equal(sanitizeForDisplay("裸 ESC\x1b 残留"), "裸 ESC\\x1b 残留");
});


test("模型选择只接受非旧版本，replay 不回滚，旧排队补配置事件同步", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 10, replay: [], snapshot: snapshot({ tasks: [task("queued", { status: "queued" })] }) }, false);
  const selection = { provider: "other", modelId: "model", thinkingLevel: "off" as const };
  state.applySessionModel("sess_1", selection, 3);
  state.applySessionModel("sess_1", { ...selection, modelId: "stale" }, 2);
  state.applyEvent(ev(2, { type: "session.model_selection_changed", sessionId: "sess_1", modelSelection: { ...selection, modelId: "replay" }, modelSelectionVersion: 4 }), "replay");
  assert.deepEqual(state.sessions[0]!.modelSelection, selection);
  assert.equal(state.sessions[0]!.modelSelectionVersion, 3);
  state.applyEvent(ev(11, { type: "tasks.model_selection_recorded", sessionId: "sess_1", taskIds: ["queued"], modelSelection: selection }), "live");
  assert.deepEqual(state.getTask("queued")!.modelSelection, selection);
});

// ---------- 自动审查（issue 15） ----------

test("accessModeLabel/formatAccessMode：四种会话模式的显示名", () => {
  assert.equal(accessModeLabel("plan"), "☷ Plan");
  assert.equal(formatAccessMode("plan", null), "☷ Plan");
  assert.equal(accessModeLabel("auto-review"), "⏵⏵ Auto review");
  assert.equal(accessModeLabel("confirm"), "⏸ Ask for approval");
  assert.equal(accessModeLabel("full_access"), "⏵⏵ Full access");
  assert.equal(formatAccessMode("auto-review", null), "⏵⏵ Auto review");
  assert.equal(formatAccessMode("confirm", "auto-review"), "⏸ Ask for approval（待切换：⏵⏵ Auto review）");
  // 着色：Auto review 蓝、Full access 橙黄、Ask for approval 不改色
  assert.match(accessModeStyle("auto-review")("X"), /^\x1b\[38;5;75mX\x1b\[0m$/);
  assert.match(accessModeStyle("full_access")("X"), /^\x1b\[38;5;214mX\x1b\[0m$/);
  assert.equal(accessModeStyle("confirm")("X"), "X");
});

test("Plan 默认值按版本更新，排队事件与重连快照保留任务独立的 Plan 标记", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 10, replay: [], snapshot: snapshot() }, false);
  state.applyEvent(ev(11, { type: "session.default_mode_changed", sessionId: "sess_1", defaultAccessMode: "plan", defaultAccessModeVersion: 2 }), "live");
  state.applySessionDefaultMode("sess_1", "full_access", 1);
  state.applyEvent(ev(9, { type: "session.default_mode_changed", sessionId: "sess_1", defaultAccessMode: "confirm", defaultAccessModeVersion: 3 }), "replay");
  assert.equal(state.sessions[0]!.defaultAccessMode, "plan");
  state.applyEvent(ev(12, { type: "task.queued", taskId: "plan", sessionId: "sess_1", requestId: "r-plan", accessMode: "auto-review", planMode: true, modelSelection: snapshot().sessions[0]!.modelSelection! }), "live");
  const queued = state.getTask("plan")!;
  assert.equal(queued.input, "", "仅凭事件标记即可识别其他客户端提交的 Plan");
  assert.equal(queued.planMode, true);
  state.applySessionDefaultMode("sess_1", "full_access", 3);
  assert.equal(queued.accessMode, "auto-review");
  assert.equal(queued.planMode, true, "改会话默认值不改已提交任务");
  const sessions = snapshot().sessions.map((s) => ({ ...s, defaultAccessMode: "plan" as const, defaultAccessModeVersion: 4 }));
  state.applySnapshot({ seq: 20, replay: [], snapshot: snapshot({ sessions, tasks: [queued] }) }, false);
  assert.equal(state.sessions[0]!.defaultAccessMode, "plan");
  assert.equal(state.getTask("plan")!.planMode, true);
});

test("自动审查事件：awaiting 携带审查状态，reviewed 转人工更新视图，resolved 标注来源", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 1, replay: [], snapshot: snapshot({ tasks: [task("task_1")] }) }, false);
  state.applyEvent(
    ev(2, {
      type: "task.awaiting_confirmation",
      taskId: "task_1",
      confirmationId: "conf_1",
      toolOpId: "op_1",
      toolName: "request_file_access",
      params: { path: "/x" },
      scope: { kind: "file_operation", path: "/x", access: "read", originalSha256: null, contentSha256: null, contentBytes: null },
      permissionVersion: 1,
      reviewStatus: "in_progress",
      reviewModel: "mock/mock-model",
      reviewPolicyVersion: "auto-review-v1",
    }),
    "live",
  );
  const pending = state.pendingApprovals();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.reviewStatus, "in_progress", "审查中的审批进入待决列表并带审查状态");
  assert.equal(pending[0]!.reviewModel, "mock/mock-model");

  // 转人工：审批仍 pending，审查状态与理由更新，提示原因
  state.applyEvent(ev(3, { type: "task.confirmation_reviewed", taskId: "task_1", confirmationId: "conf_1", decision: "ask_owner", reason: "无法确认用途" }), "live");
  assert.equal(state.confirmations[0]!.reviewStatus, "asked_owner");
  assert.equal(state.getTask("task_1")!.status, "awaiting_confirmation");
  assert.equal(state.confirmations[0]!.reviewReason, "无法确认用途");
  assert.ok(notes(state.openSession("sess_1")).some((n) => n.text.includes("自动审查转人工：无法确认用途")));

  // 自动审查的决定：移除待决并提示来源与理由
  state.applyEvent(ev(4, { type: "task.confirmation_resolved", taskId: "task_1", confirmationId: "conf_1", decision: "approved", source: "auto_review", reason: "与请求相关" }), "live");
  assert.equal(state.pendingApprovals().length, 0);
  assert.equal(state.getTask("task_1")!.status, "running");
  assert.ok(notes(state.openSession("sess_1")).some((n) => n.text.includes("自动审查已批准：与请求相关")));

  // 人工决定不额外提示（现有行为）
  state.applyEvent(
    ev(5, {
      type: "task.awaiting_confirmation",
      taskId: "task_1",
      confirmationId: "conf_2",
      toolOpId: "op_2",
      toolName: "bash",
      params: {},
      scope: { kind: "tool", workspaceOnly: true },
      permissionVersion: 1,
    }),
    "live",
  );
  const notesBefore = notes(state.openSession("sess_1")).length;
  state.applyEvent(ev(6, { type: "task.confirmation_resolved", taskId: "task_1", confirmationId: "conf_2", decision: "approved", source: "owner" }), "live");
  assert.equal(state.pendingApprovals().length, 0);
  assert.equal(notes(state.openSession("sess_1")).length, notesBefore, "人工决定不新增来源提示");
});

test("MCP 事件：服务变更全局提示与任务内不可用提示（issue 16）", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 1, replay: [], snapshot: snapshot({ tasks: [task("task_1")] }) }, false);
  state.openSession("sess_1");
  state.applyEvent(
    ev(2, { type: "mcp.service_changed", serviceId: "s1", projectId: "proj_1", name: "docs", endpoint: "https://mcp.example.com/mcp/", configVersion: 2, action: "disabled" }),
    "live",
  );
  state.applyEvent(
    ev(3, { type: "mcp.service_unavailable", serviceId: "s1", projectId: "proj_1", taskId: "task_1", sessionId: "sess_1", name: "docs", endpoint: "https://mcp.example.com/mcp/", reason: "连接超时（timeout）" }),
    "live",
  );
  assert.ok(state.globalNotes.some((n) => n.text.includes("MCP 服务 docs") && n.text.includes("已禁用")), "服务变更进全局提示");
  const view = state.openSession("sess_1");
  assert.ok(notes(view).some((n) => n.text.includes("MCP 服务 docs") && n.text.includes("不可用") && n.text.includes("连接超时")), "不可用原因进会话提示");
});

test("github.* 历史事件：退役后按归档记录展示，不再提示旧命令（issue 17）", () => {
  const state = new ViewState();
  state.applySnapshot({ seq: 1, replay: [], snapshot: snapshot({ tasks: [task("task_1")] }) }, false);
  state.openSession("sess_1");
  // 提示由 live 事件产生（replay 的状态以快照为准，不重复生成提示——既有设计）
  state.applyEvent(
    ev(2, { type: "github.draft_saved", draftId: "draft_abc123456", version: 2, taskId: "task_1", sessionId: "sess_1", kind: "pr_review", bodySha256: "x".repeat(64), bodyBytes: 128 }),
    "live",
  );
  state.applyEvent(
    ev(3, { type: "github.publish_settled", publishOpId: "pub_def456789", draftId: "draft_abc123456", status: "effect_unknown", remoteUrl: null, errorMessage: "退役迁移：批准已消费" }),
    "live",
  );
  const view = state.openSession("sess_1");
  const all = [...notes(view), ...state.globalNotes].map((n) => n.text).join("\n");
  assert.ok(all.includes("历史记录"), "github 事件按归档记录展示");
  assert.ok(!all.includes("/github"), "不再提示已退役的 /github 命令");
});
