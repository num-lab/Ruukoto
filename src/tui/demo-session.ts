/**
 * 合成调试会话（`ruukoto tui --demo`）：不连后台，用一个假客户端喂出
 * 覆盖全部事件类型与界面状态的静态数据，用来调试 TUI 渲染。
 *
 * 目的：真实后台很难同时造出「运行中任务 + 待审批 + 队列暂停 + 各类终态 +
 * 各种工具结果 + 长输出截断」，逐个手搓成本高。这里一次给全。
 *
 * 边界：只用于调试展示。不执行任务、不读写数据目录、不需要拥有者令牌；
 * 命令会明确提示这是合成会话，避免被当成真实运行状态。
 */

import type { ControlClient } from "../control/client.ts";
import type { ConnectResult } from "../control/protocol.ts";
import type { ContextBreakdown } from "../agent/context-selector.ts";
import type {
  ConfirmationRequest,
  ModelSelection,
  PersistentEvent,
  PersistentEventBody,
  Project,
  SelectionRecord,
  Session,
  Task,
  ToolOp,
} from "../core/types.ts";
import { confirmationToView, toolOpToView } from "../core/views.ts";
import type { HistoryEntryView, HistoryPage } from "../core/history.ts";
import { editStatsFromResult, sliceTextByBytes } from "../core/history.ts";

const PROJECT_ID = "proj_demo";
const SESSION_ID = "sess_demo0000000000000000";
const NOW = "2026-09-22T10:00:00.000Z";

const MODEL: ModelSelection = { provider: "demo", modelId: "demo-model", thinkingLevel: "medium" };
const EDIT_STATS = editStatsFromResult("edit", false, { patch: "@@ -1 +1,3 @@\n-const old = true;\n+const first = true;\n+const second = true;\n+const third = true;" })!;

function ts(minutesAgo: number): string {
  return new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
}

function task(over: Partial<Task> & { id: string; status: Task["status"] }): Task {
  return {
    sessionId: SESSION_ID,
    requestId: `req-${over.id}`,
    input: "合成任务",
    modelSelection: MODEL,
    submissionDigest: null,
    accessMode: "confirm",
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
    createdAt: ts(60),
    startedAt: ts(59),
    endedAt: ts(50),
    ...over,
  };
}

/** 覆盖各终态与进行中状态的任务集合。 */
function demoTasks(): Task[] {
  return [
    task({ id: "task_running000000", status: "running", input: "正在执行的任务（流式输出中）", createdAt: ts(2), startedAt: ts(2), endedAt: null }),
    task({ id: "task_awaiting0000", status: "awaiting_confirmation", input: "等待审批的任务（自动审查已转人工）", accessMode: "auto-review", createdAt: ts(5), startedAt: ts(5), endedAt: null }),
    task({ id: "task_queued000000", status: "queued", input: "排队中的任务", createdAt: ts(1), startedAt: null, endedAt: null }),
    task({ id: "task_completed000", status: "completed", input: "已完成的任务", accessMode: "full_access" }),
    task({ id: "task_failed00000", status: "failed", input: "失败的任务", errorMessage: "模型返回 429：速率限制" }),
    task({ id: "task_canceled000", status: "canceled", input: "被取消的任务", cancelRequested: true }),
    task({
      id: "task_interrupt00",
      status: "interrupted",
      input: "被中断的任务",
      interruptReason: "backend_restart",
      effectUnknown: true,
    }),
    task({ id: "task_contd000000", status: "running", input: "继续自中断任务的任务", resumesTaskId: "task_interrupt00", createdAt: ts(1), startedAt: ts(1), endedAt: null }),
  ];
}

const PROJECT: Project = { id: PROJECT_ID, name: "合成项目", createRequestId: null, instructionFiles: ["AGENTS.md"], webSearch: "enabled", createdAt: ts(120) };

const SESSION: Session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  kind: "dev",
  cwd: "/srv/demo/work",
  cwdReal: "/srv/demo/work",
  cwdDev: 1,
  cwdIno: 1,
  piSessionId: "pi_demo",
  sessionFile: "/srv/demo/data/sessions/pi_demo.jsonl",
  confirmTools: [],
  createRequestId: null,
  modelSelection: MODEL,
  modelSelectionVersion: 3,
  defaultAccessMode: "confirm",
  defaultAccessModeVersion: 0,
  queueState: "paused",
  queuePauseReason: "backend_restart",
  createdAt: ts(120),
};

const CONFIRMATION: ConfirmationRequest = {
  id: "conf_demo00000000",
  taskId: "task_awaiting0000",
  sessionId: SESSION_ID,
  toolOpId: "toolop_demo000000",
  toolName: "http_request",
  params: {
    method: "POST",
    url: "https://api.example.com/v1/deploy",
    purpose: "部署到预发环境",
    credential: "deploy-token",
    body: { version: "0.1.0", note: "合成调试数据" },
  },
  scope: { kind: "http_request", method: "POST", url: "https://api.example.com/v1/deploy", credentials: [{ name: "deploy-token", purpose: "部署到预发环境" }] },
  cwdDev: 1,
  cwdIno: 1,
  permissionVersion: 1,
  status: "pending",
  createdAt: ts(5),
  respondedAt: null,
  consumedAt: null,
  // 自动审查已转人工的演示记录（审查结论与理由随审批展示）
  reviewStatus: "asked_owner",
  reviewDecision: "ask_owner",
  reviewReason: "带凭据的写入不属于自动批准范围",
  reviewModel: "demo/demo-model",
  reviewPolicyVersion: "auto-review-v1",
  decisionSource: null,
};

/** 历史条目：覆盖各角色与边界（截断、工具错误、含非文本内容）。 */
function historyEntries(): HistoryEntryView[] {
  const entry = (over: Partial<HistoryEntryView> & { entryId: string; role: string; text: string }): HistoryEntryView => ({
    parentId: null,
    timestamp: ts(30),
    offset: 0,
    totalBytes: Buffer.byteLength(over.text, "utf8"),
    truncated: false,
    toolCalls: [],
    toolCallId: null,
    toolName: null,
    isError: null,
    hasNonTextContent: false,
    ...over,
  });
  return [
    entry({
      entryId: "entry_0001",
      role: "user",
      text: "帮我看一下 src/tui/app.ts 的布局代码，说明根布局是怎么组织的。",
      timestamp: ts(40),
    }),
    entry({
      entryId: "entry_0002",
      role: "assistant",
      text: [
        "根布局是一个 `VStack`，五个区块从上到下：",
        "",
        "1. **header** — 项目 / 会话 / 工作目录 / 连接状态",
        "2. **ScrollView** — 转录区，`grow: 1` 吃掉剩余空间",
        "3. **statusLine** — 任务与队列状态",
        "4. **Editor** — 多行输入",
        "5. **footer** — 左侧模式与工作区，右侧模型信息",
        "",
        "```ts",
        "const root = new VStack([",
        '  { component: this.header, grow: 0, shrink: 1 },',
        '  { component: this.scroll, grow: 1, shrink: 1, minSize: 1 },',
        "]);",
        "```",
        "",
        "链接示例：[pi-tui](https://github.com/earendil-works/pi) 与行内代码 `visibleWidth`。",
      ].join("\n"),
      timestamp: ts(39),
      toolCalls: [{ toolCallId: "call_1", toolName: "read" }],
    }),
    entry({
      entryId: "entry_0003",
      role: "toolResult",
      text: "export class TuiApp {\n  private readonly connection: ControlConnection;\n  // …（合成数据）",
      toolCallId: "call_1",
      toolName: "read",
      isError: false,
      timestamp: ts(38),
    }),
    entry({
      entryId: "entry_0004",
      role: "toolResult",
      text: "Error: ENOENT: no such file or directory, open '/srv/demo/work/missing.ts'",
      toolCallId: "call_2",
      toolName: "read",
      isError: true,
      timestamp: ts(37),
    }),
    entry({
      entryId: "entry_0005",
      role: "assistant",
      text: "长正文开头。\n" + "完整正文通过 UTF-8 字节分页恢复，内容不得重复或遗漏。\n".repeat(1000) + "长正文结尾。",
      timestamp: ts(36),
    }),
    entry({
      entryId: "entry_0006",
      role: "user",
      text: "再看一下权限模式是怎么落到容器边界的。",
      timestamp: ts(20),
    }),
    entry({
      entryId: "entry_0007",
      role: "assistant",
      text: "请求确认模式的任务在按任务建立的容器内执行；完全访问在容器外以固定执行账户运行。",
      hasNonTextContent: true,
      timestamp: ts(19),
    }),
    entry({ entryId: "entry_0008", role: "toolResult", text: "Updated src/tui/state.ts", toolCallId: "call_edit", toolName: "edit", isError: false, editStats: EDIT_STATS, timestamp: ts(35) }),
  ];
}

/** 合成选择记录：callIndex 与 usage 可变，其余为固定示例值。 */
function demoRecord(callIndex: number, usage: { input: number; output: number } | null): SelectionRecord {
  return {
    id: `rec_demo0000000${callIndex}`,
    taskId: "task_completed000",
    sessionId: SESSION_ID,
    callIndex,
    strategy: "deterministic-v1",
    configVersion: 1234567,
    model: "demo-model",
    totalMessages: 50,
    includedIndices: Array.from({ length: 42 }, (_, i) => i),
    excluded: [
      { index: 42, reason: "budget_exceeded" },
      { index: 43, reason: "budget_exceeded" },
      { index: 44, reason: "unpaired_tool_call:call_x" },
    ],
    includedMemories: [
      { memoryId: "mem_demo0001", version: 2 },
      { memoryId: "mem_demo0002", version: 1 },
    ],
    excludedMemories: [{ memoryId: "mem_demo0003", version: 4, reason: "budget_exceeded" }],
    instructionVersion: "a1b2c3d4",
    cappedToolResults: [{ index: 17, originalChars: 98304, viewChars: 4096 }],
    estimates: { systemPrompt: 3000, toolSchemas: 12000, projectInstructions: 1000, memories: 900, mandatoryTurn: 8000, historyTurns: 45000 },
    budget: 178000,
    estimatedTotal: 69900,
    usage,
    promptArtifactId: "art_demo0000000001",
    windowSnapshot: { contextWindow: 200000, maxTokens: 8000, thinkingBudget: 0, toolResultReserve: 4000, safetyMargin: 2000 },
    createdAt: ts(35 - callIndex),
  };
}

/** 合成分解：当前窗口状态（含窗口快照）。 */
function demoBreakdown(): ContextBreakdown {
  return {
    budget: 178000,
    estimatedTotal: 69900,
    remainingInput: 108100,
    window: { contextWindow: 200000, maxTokens: 8000, thinkingBudget: 0, toolResultReserve: 4000, safetyMargin: 2000 },
    windowUnavailableReason: null,
    categories: [
      { key: "systemPrompt", label: "系统提示", tokens: 3000, pctOfBudget: 1.7, pctOfWindow: 1.5 },
      { key: "toolSchemas", label: "工具定义", tokens: 12000, pctOfBudget: 6.7, pctOfWindow: 6.0 },
      { key: "projectInstructions", label: "项目指令", tokens: 1000, pctOfBudget: 0.6, pctOfWindow: 0.5 },
      { key: "memories", label: "长期记忆", tokens: 900, pctOfBudget: 0.5, pctOfWindow: 0.5 },
      { key: "mandatoryTurn", label: "当前任务", tokens: 8000, pctOfBudget: 4.5, pctOfWindow: 4.0 },
      { key: "historyTurns", label: "历史轮次", tokens: 45000, pctOfBudget: 25.3, pctOfWindow: 22.5 },
    ],
    other: null,
  };
}

/** 覆盖全部事件类型的事件流（seq 从 1 连续递增）。 */
function demoEvents(): PersistentEvent[] {
  const entries = historyEntries();
  const answer = entries.find((entry) => entry.entryId === "entry_0002")!.text;
  const split = answer.indexOf("\n\n");
  const first = answer.slice(0, split);
  const second = answer.slice(split);
  const bodies: PersistentEventBody[] = [
    { type: "backend.started", dataDir: "/srv/demo/data", executionBackend: "container" },
    { type: "project.created", projectId: PROJECT_ID, name: PROJECT.name, createRequestId: null },
    { type: "session.created", sessionId: SESSION_ID, projectId: PROJECT_ID, kind: "dev", cwd: SESSION.cwd, modelSelection: MODEL, modelSelectionVersion: 1, createRequestId: null },
    { type: "session.model_selection_changed", sessionId: SESSION_ID, modelSelection: MODEL, modelSelectionVersion: 3 },
    { type: "session.default_mode_changed", sessionId: SESSION_ID, defaultAccessMode: "confirm", defaultAccessModeVersion: 1 },
    { type: "task.queued", taskId: "task_completed000", sessionId: SESSION_ID, requestId: "req-1", accessMode: "full_access", modelSelection: MODEL },
    { type: "task.started", taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "task.output_fragment", taskId: "task_completed000", sessionId: SESSION_ID, messageId: "msg_1", text: first, totalBytes: Buffer.byteLength(first), truncated: false, partial: true, contentIndex: 0, offset: 0, startedAt: ts(39.5) },
    { type: "task.thinking", taskId: "task_completed000", sessionId: SESSION_ID, messageId: "msg_1", thinkingId: "thought_demo1", startedAt: ts(39.4), endedAt: null, text: "I'll inspect the layout and keep each event in its original position." },
    { type: "task.thinking", taskId: "task_completed000", sessionId: SESSION_ID, messageId: "msg_1", thinkingId: "thought_demo1", startedAt: ts(39.4), endedAt: new Date(Date.parse(ts(39.4)) + 22_000).toISOString(), text: "I'll inspect the layout and keep each event in its original position." },
    { type: "task.output_fragment", taskId: "task_completed000", sessionId: SESSION_ID, messageId: "msg_1", text: second, totalBytes: Buffer.byteLength(second), truncated: false, partial: true, contentIndex: 1, offset: 0, startedAt: ts(39) },
    { type: "task.tool_intent", taskId: "task_completed000", toolOpId: "toolop_demo000001", sdkCallId: "call_1", toolName: "read", params: { path: "src/tui/app.ts" } },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000001", summary: "读取 1660 行", isError: false, artifactIds: [] },
    { type: "task.tool_intent", taskId: "task_completed000", toolOpId: "toolop_demo000002", sdkCallId: "call_live_2", toolName: "bash", params: { command: "npm run typecheck" } },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000002", summary: "命令失败：退出码 1", isError: true, artifactIds: ["art_demo0000000001"] },
    { type: "task.tool_intent", taskId: "task_completed000", toolOpId: "toolop_demo000004", sdkCallId: "call_2", toolName: "read", params: { path: "missing.ts" } },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000004", summary: "ENOENT: missing.ts", isError: true, artifactIds: [] },
    { type: "task.tool_intent", taskId: "task_completed000", toolOpId: "toolop_demo000005", sdkCallId: "call_edit", toolName: "edit", params: { path: "src/tui/state.ts" } },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000005", summary: "Updated src/tui/state.ts", isError: false, artifactIds: [], editStats: EDIT_STATS },
    { type: "task.tool_intent", taskId: "task_interrupt00", toolOpId: "toolop_demo000003", sdkCallId: "call_live_3", toolName: "bash", params: { command: "rm -rf /srv/work/tmp" } },
    { type: "task.tool_effect_unknown", taskId: "task_interrupt00", toolOpId: "toolop_demo000003", toolName: "bash" },
    { type: "task.output_entry", taskId: "task_completed000", sessionId: SESSION_ID, entryId: "entry_0002", sessionFile: SESSION.sessionFile!, role: "assistant", messageId: "msg_1" },
    ...["entry_0001", "entry_0003", "entry_0004", "entry_0005", "entry_0008", "entry_0006", "entry_0007"].map((id): PersistentEventBody => {
      const entry = entries.find((item) => item.entryId === id)!;
      return { type: "task.output_entry", taskId: id === "entry_0006" || id === "entry_0007" ? "task_contd000000" : "task_completed000", sessionId: SESSION_ID, entryId: id, sessionFile: SESSION.sessionFile!, role: entry.role, messageId: entry.role === "assistant" ? `msg_${id}` : null };
    }),
    { type: "task.completed", taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "task.queued", taskId: "task_awaiting0000", sessionId: SESSION_ID, requestId: "req-2", accessMode: "auto-review", modelSelection: MODEL },
    { type: "task.started", taskId: "task_awaiting0000", sessionId: SESSION_ID },
    {
      type: "task.awaiting_confirmation",
      taskId: "task_awaiting0000",
      confirmationId: CONFIRMATION.id,
      toolOpId: CONFIRMATION.toolOpId,
      toolName: CONFIRMATION.toolName,
      params: CONFIRMATION.params,
      scope: CONFIRMATION.scope,
      permissionVersion: 1,
      reviewStatus: "in_progress",
      reviewModel: "demo/demo-model",
      reviewPolicyVersion: "auto-review-v1",
    },
    { type: "task.confirmation_reviewed", taskId: "task_awaiting0000", confirmationId: CONFIRMATION.id, decision: "ask_owner", reason: "带凭据的写入不属于自动批准范围" },
    { type: "task.confirmation_resolved", taskId: "task_awaiting0000", confirmationId: "conf_old000000000", decision: "rejected" },
    { type: "task.approval_consumed", taskId: "task_completed000", confirmationId: "conf_old000000001", toolOpId: "toolop_demo000001", toolName: "read" },
    { type: "task.mode_switch_requested", taskId: "task_running000000", sessionId: SESSION_ID, from: "confirm", to: "full_access" },
    { type: "task.mode_switched", taskId: "task_running000000", sessionId: SESSION_ID, from: "confirm", to: "full_access", permissionVersion: 2 },
    { type: "task.mode_switch_failed", taskId: "task_failed00000", sessionId: SESSION_ID, to: "full_access", reason: "任务已结束" },
    { type: "task.thinking", taskId: "task_running000000", sessionId: SESSION_ID, messageId: "msg_live", thinkingId: "thought_live", startedAt: ts(2), endedAt: null, text: "正在检查任务恢复与终端宽度。最新内容保留在这一行的尾部。" },
    { type: "task.queued", taskId: "task_failed00000", sessionId: SESSION_ID, requestId: "req-3", accessMode: "confirm", modelSelection: MODEL },
    { type: "task.failed", taskId: "task_failed00000", sessionId: SESSION_ID, errorMessage: "模型返回 429：速率限制" },
    { type: "task.queued", taskId: "task_canceled000", sessionId: SESSION_ID, requestId: "req-4", accessMode: "confirm", modelSelection: MODEL },
    { type: "task.canceled", taskId: "task_canceled000", sessionId: SESSION_ID },
    { type: "task.queued", taskId: "task_interrupt00", sessionId: SESSION_ID, requestId: "req-5", accessMode: "confirm", modelSelection: MODEL },
    { type: "task.interrupted", taskId: "task_interrupt00", sessionId: SESSION_ID, reason: "backend_restart", cancelRequested: false, effectUnknown: true },
    { type: "task.continued", taskId: "task_contd000000", sessionId: SESSION_ID, resumesTaskId: "task_interrupt00" },
    { type: "task.tool_process_unreaped", taskId: "task_interrupt00", sessionId: SESSION_ID, reason: "容器未在期限内回收" },
    { type: "session.queue_paused", sessionId: SESSION_ID, reason: "backend_restart" },
    { type: "session.queue_resumed", sessionId: SESSION_ID },
    { type: "occupancy.stale", sessionId: SESSION_ID, taskId: "task_interrupt00", cwdReal: SESSION.cwd },
    { type: "session.history_unreadable", sessionId: SESSION_ID, sessionFile: "/srv/demo/data/sessions/gone.jsonl", error: "文件缺失" },
    { type: "data_grant.created", grantId: "grant_demo000000", fromProjectId: "proj_other", toProjectId: PROJECT_ID, category: "history" },
    { type: "data_grant.revoked", grantId: "grant_demo000000", fromProjectId: "proj_other", toProjectId: PROJECT_ID, category: "history" },
    { type: "memory.saved", memoryId: "mem_demo00000000", projectId: PROJECT_ID, version: 1, author: "agent", taskId: "task_completed000" },
    { type: "memory.revoked", memoryId: "mem_demo00000000", projectId: PROJECT_ID, version: 2, author: "owner", taskId: null },
    { type: "memory.restored", memoryId: "mem_demo00000000", projectId: PROJECT_ID, fromVersion: 1, newVersion: 3, author: "owner", taskId: null },
    // issue 21 §4：模型配置在线应用（目录/凭据/后台默认模型）
    { type: "model.config_changed", kind: "api_key", provider: "demo" },
    // issue 17：github.* 事件类型已退役，以下仅为历史记录的渲染样例（不再产生新实例）
    { type: "github.binding_changed", bindingId: "bind_demo0000000", projectId: PROJECT_ID, apiHost: "api.github.com", owner: "demo", repo: "demo-repo", configVersion: 2, action: "upsert" },
    { type: "github.draft_saved", draftId: "draft_demo000000", version: 1, taskId: "task_completed000", sessionId: SESSION_ID, kind: "pr_review_comment", bodySha256: "a".repeat(64), bodyBytes: 2048 },
    { type: "github.draft_stale", draftId: "draft_demo000000", version: 1, reason: "PR head SHA 已变化" },
    { type: "github.publish_requested", publishOpId: "pub_demo00000000", draftId: "draft_demo000000", draftVersion: 1, taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "github.publish_settled", publishOpId: "pub_demo00000000", draftId: "draft_demo000000", status: "effect_unknown", remoteUrl: null, errorMessage: "发送后超时" },
    { type: "mcp.service_changed", serviceId: "mcps_demo000000", projectId: PROJECT_ID, name: "docs", endpoint: "https://mcp.example.com/mcp/", configVersion: 1, action: "upsert" },
    { type: "mcp.service_unavailable", serviceId: "mcps_demo000000", projectId: PROJECT_ID, taskId: "task_completed000", sessionId: SESSION_ID, name: "docs", endpoint: "https://mcp.example.com/mcp/", reason: "连接超时（timeout）" },
    // issue 07：QQ 群聊入口配置变化（群允许列表增删/启停/连接参数）
    { type: "qq.config_changed", configVersion: 3, action: "group_added", groupId: "100001" },
    { type: "qq.receive_gap", from: ts(70), to: ts(62) },
    { type: "tasks.model_selection_recorded", sessionId: SESSION_ID, taskIds: ["task_queued000000"], modelSelection: MODEL },
    { type: "backend.recovered", interruptedTaskIds: ["task_interrupt00"], pausedSessionIds: [SESSION_ID] },
    // issue 01：入站事件与子任务编排（角色任务结果回传与有界唤醒）
    { type: "inbound.registered", eventId: "evt_demo000000001", source: "telegram", externalId: "msg-42", targetRole: "main", actor: "owner" },
    { type: "inbound.queued", eventId: "evt_demo000000001", taskId: "task_completed000", targetRole: "main" },
    { type: "inbound.skipped", eventId: "evt_demo000000002", source: "qq_private", reason: "qq_private_target_changed" },
    { type: "chat_result.accepted", taskId: "task_completed000", acceptedByTaskId: "task_running000000", acceptedByOpId: "op_chat_accept000" },
    { type: "child_task.completed", taskId: "task_completed000", parentTaskId: "task_running000000", agentId: "coding", summary: "分析结论：仓库健康", resultRef: "{\"sessionId\":\"sess_demo0000000000000000\",\"taskId\":\"task_completed000\"}" },
    { type: "child_task.failed", taskId: "task_failed00000", parentTaskId: "task_running000000", agentId: "coding", errorMessage: "模型返回 429：速率限制" },
    { type: "child_task.timeout", taskId: "task_canceled000", parentTaskId: "task_running000000", agentId: "coding", deadline: ts(5) },
    { type: "child_task.result_unknown", taskId: "task_interrupt00", parentTaskId: null, agentId: "main", reason: "backend_restart" },
    // issue 02：main 应用数据空间（能力停止与操作拒绝）
    { type: "app_data.unavailable", reason: "应用数据库实例标识与登记不符：保留未知效果，能力停止" },
    { type: "app_data.rejected", taskId: "task_completed000", sessionId: SESSION_ID, source: "validation", toolName: "app_data_define_table", code: "reserved_name" },
    { type: "schedule.changed", scheduleId: "sch_demo00000001", action: "created", version: 1, source: "main_tool", reason: "每日提醒" },
    { type: "schedule.run", scheduleId: "sch_demo00000001", runId: "run_demo00000001", action: "registered", scheduledFor: "2026-09-24T01:00:00.000Z", delayMs: 0, coalescedFrom: null, coalescedTo: null },
    { type: "schedule.news", scheduleId: "sch_demo00000001", runId: "run_demo00000001", status: "completed", itemCount: 3 },
    { type: "notification.changed", opId: "nop_demo00000001", status: "effect_unknown", sourceKind: "schedule_run", reason: "timeout_or_abort" },
    // issue 04：Telegram owner 入口
    { type: "telegram.config_changed", configVersion: 2, action: "enabled" },
    { type: "telegram.rejected", updateId: 101, chatId: "99", userId: "99", reason: "not_owner" },
    { type: "telegram.reply_skipped", eventId: "evt_demo00000001", taskId: "task_completed000", reason: "target_unavailable" },
    { type: "qq_private.reply_skipped", eventId: "evt_demo00000002", taskId: "task_completed000", reason: "target_changed" },
    { type: "backend.stopping", reason: "signal_sigterm" },
    { type: "backend.stopped", reason: "signal_sigterm" },
  ];
  return bodies.map((body, i) => ({
    seq: i + 1,
    taskId: "taskId" in body ? (body.taskId as string) : null,
    // 任务域事件的身体不带 sessionId，但信封要带（真实后台如此）——否则 TUI
    // 无法定位会话视图，tool_intent 等显示事件会被静默丢弃
    sessionId: "sessionId" in body ? (body.sessionId as string) : "taskId" in body ? SESSION_ID : null,
    body,
    createdAt: ts(60 - i),
  }));
}

/**
 * 假客户端：只实现 TUI 用到的那部分控制面。
 * 请求应答是静态的；事件在握手后按固定间隔推送，模拟实时流。
 *
 * @param onNotice 界面内提示（事件数量、推送完毕等）
 * @param intervalMs 事件推送间隔（默认 250ms；测试可调小以加速）
 */
export function createDemoClient(onNotice: (text: string) => void, intervalMs = 250): ControlClient {
  const events = demoEvents();
  const entries = historyEntries();
  const tasks = demoTasks().map((task) => ({ ...task, historyEntryIds: events.flatMap((event) => event.taskId === task.id && event.body.type === "task.output_entry" ? [event.body.entryId] : []) }));
  const toolOps = new Map<string, ToolOp>();
  for (const event of events) {
    const body = event.body;
    if (body.type === "task.tool_intent") {
      toolOps.set(body.toolOpId, { id: body.toolOpId, taskId: body.taskId, toolName: body.toolName, sdkCallId: body.sdkCallId, params: body.params, intentRecordedAt: event.createdAt, resultSummary: null, isError: null, effectUnknown: false, recordedResultAt: null });
    } else if (body.type === "task.tool_result") {
      const op = toolOps.get(body.toolOpId);
      if (op) Object.assign(op, { resultSummary: body.summary, isError: body.isError, recordedResultAt: event.createdAt });
    } else if (body.type === "task.tool_effect_unknown") {
      const op = toolOps.get(body.toolOpId);
      if (op) op.effectUnknown = true;
    }
  }
  const eventListeners = new Set<(event: PersistentEvent) => void>();
  const closeListeners = new Set<(info: { reason: string; willRetry: boolean }) => void>();
  let closed = false;
  let cursor = 0;
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (): ConnectResult["snapshot"] => ({
    projects: [PROJECT],
    sessions: [SESSION],
    tasks,
    confirmations: [confirmationToView(CONFIRMATION)],
    artifacts: [
      { id: "art_demo0000000001", taskId: "task_completed000", sessionId: SESSION_ID, name: "bash 输出", byteCount: 96 * 1024, status: "complete", createdAt: ts(30) },
    ],
    previews: {
      task_running000000: { messageId: "msg_live", text: "正在生成合成输出…\n第二行内容用于验证预览区域的高度与换行。", totalBytes: 64, truncated: false, seq: 4, state: "generating" },
    },
    instanceId: "inst_demo",
    execution: { backend: "container", note: "合成会话：不执行任何任务" },
    defaultModel: { provider: MODEL.provider, id: MODEL.modelId, name: "Demo Model", thinkingLevel: MODEL.thinkingLevel },
  });

  const client = {
    get isClosed() {
      return closed;
    },
    async authenticate() {
      // 合成会话不校验令牌
    },
    async handshake(): Promise<ConnectResult> {
      // 先推前几条，让界面在握手后立刻有事件可看
      const result: ConnectResult = { seq: 0, replay: [], snapshot: snapshot() };
      startStreaming();
      return result;
    },
    async request<T>(op: string, params?: Record<string, unknown>): Promise<T> {
      const reply = (value: unknown) => value as T;
      switch (op) {
        case "read_history": {
          const end = params?.before ? entries.findIndex((entry) => entry.entryId === params.before) : entries.length;
          const limit = Math.max(1, Number(params?.limit ?? 50));
          const selected = entries.slice(Math.max(0, end - limit), end);
          const page: HistoryPage = { fileAvailable: true, hasPartialTail: false, entries: selected.map((entry) => ({ ...entry, ...sliceTextByBytes(entry.text, 0, 8 * 1024) })), nextBefore: end > limit ? selected[0]!.entryId : null };
          return reply(page);
        }
        case "read_history_entry": {
          const found = entries.find((e) => e.entryId === params?.["entry_id"]);
          if (!found) throw new Error(`合成会话：未知条目 ${String(params?.["entry_id"])}`);
          return reply({ ...found, ...sliceTextByBytes(found.text, Number(params?.offset ?? 0), Number(params?.length ?? 48 * 1024)) });
        }
        case "get_task": {
          const found = tasks.find((t) => t.id === params?.["task_id"]);
          if (!found) throw new Error(`合成会话：未知任务 ${String(params?.["task_id"])}`);
          return reply({ seq: events.length, task: found, toolOps: [...toolOps.values()].filter((op) => op.taskId === found.id).map(toolOpToView), confirmations: found.id === CONFIRMATION.taskId ? [confirmationToView(CONFIRMATION)] : [], artifacts: snapshot().artifacts.filter((artifact) => artifact.taskId === found.id), outputPreview: snapshot().previews[found.id] ?? null });
        }
        case "list_tasks": {
          const ordered = [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
          const start = params?.before ? ordered.findIndex((task) => task.id === params.before) + 1 : 0;
          const limit = Math.max(1, Number(params?.limit ?? 50));
          return reply({ tasks: ordered.slice(start, start + limit), hasMore: start + limit < ordered.length });
        }
        case "read_task_events": {
          if (!tasks.some((task) => task.id === params?.task_id)) throw new Error(`合成会话：未知任务 ${String(params?.task_id)}`);
          const matching = events.filter((event) => event.taskId === params?.task_id && event.seq > Number(params?.after_seq ?? 0));
          const page = matching.slice(0, Math.max(1, Math.min(500, Number(params?.limit ?? 100))));
          return reply({ events: page, nextAfter: page.length < matching.length ? page.at(-1)!.seq : null });
        }
        case "get_tool_op": {
          const found = toolOps.get(String(params?.tool_op_id));
          if (!found) throw new Error(`合成会话：未知工具操作 ${String(params?.tool_op_id)}`);
          return reply({ toolOp: found, params: sliceTextByBytes(JSON.stringify(found.params), Number(params?.offset ?? 0), Number(params?.length ?? 48 * 1024)) });
        }
        case "list_models":
          return reply({
            models: [
              { provider: "demo", modelId: "demo-model", name: "Demo Model", contextWindow: 200000, maxTokens: 8192, thinkingLevels: ["off", "minimal", "low", "medium", "high"], available: true },
              { provider: "demo", modelId: "demo-model-2", name: "Demo Model 2（长名字用于验证截断）", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off", "medium"], available: false },
              { provider: "other", modelId: "other-model", name: "Other Model", contextWindow: 64000, maxTokens: 2048, thinkingLevels: ["off"], available: true },
            ],
            total: 3,
            nextOffset: null,
          });
        case "get_session":
          return reply(SESSION);
        case "set_session_model":
          return reply({ ...SESSION, modelSelection: params?.["model_selection"] as ModelSelection });
        case "set_session_mode":
          return reply({
            ...SESSION,
            defaultAccessMode: params?.["mode"] as Session["defaultAccessMode"],
            defaultAccessModeVersion: SESSION.defaultAccessModeVersion + 1,
          });
        case "list_selection_records":
          // /context 只取最近一条（当前窗口状态）
          return reply({
            records: [
              { id: "rec_demo00000003", taskId: "task_completed000", callIndex: 3, model: "demo-model", usage: { input: 70123, output: 512 }, createdAt: ts(30) },
            ],
            hasMore: false,
          });
        case "get_context_breakdown":
          return reply({ record: demoRecord(3, { input: 70123, output: 512 }), breakdown: demoBreakdown() });
        default:
          // 其余写操作在合成会话里一律拒绝：它们不该产生真实副作用
          // （set_session_model / set_session_mode 例外：返回静态应答，供 /model、/mode 回显结果行）
          throw new Error(`合成会话不支持写操作：${op}`);
      }
    },
    onEvent(listener: (event: PersistentEvent) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onClose(listener: (info: { reason: string; willRetry: boolean }) => void) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  /** 握手后按固定间隔推送事件：可见「事件流式到达」的界面行为。 */
  function startStreaming(): void {
    if (timer || closed) return;
    onNotice(`合成会话：共 ${events.length} 条事件、${entries.length} 条历史、${demoTasks().length} 个任务（含各终态）`);
    timer = setInterval(() => {
      if (closed || cursor >= events.length) {
        if (timer) clearInterval(timer);
        timer = null;
        if (!closed) onNotice("合成会话：事件推送完毕（可继续用 /help、/model、/sessions 等查看界面）");
        return;
      }
      const event = events[cursor++]!;
      for (const listener of eventListeners) listener(event);
    }, intervalMs);
  }

  return client as unknown as ControlClient;
}
