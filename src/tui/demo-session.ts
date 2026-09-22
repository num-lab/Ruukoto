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
import type {
  ConfirmationRequest,
  ModelSelection,
  PersistentEvent,
  PersistentEventBody,
  Project,
  Session,
  Task,
} from "../core/types.ts";
import { confirmationToView } from "../core/views.ts";
import type { HistoryEntryView, HistoryPage } from "../core/history.ts";

const PROJECT_ID = "proj_demo";
const SESSION_ID = "sess_demo0000000000000000";
const NOW = "2026-09-22T10:00:00.000Z";

const MODEL: ModelSelection = { provider: "demo", modelId: "demo-model", thinkingLevel: "medium" };

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
    task({ id: "task_awaiting0000", status: "awaiting_confirmation", input: "等待审批的任务", createdAt: ts(5), startedAt: ts(5), endedAt: null }),
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

const PROJECT: Project = { id: PROJECT_ID, name: "合成项目", instructionFiles: ["AGENTS.md"], createdAt: ts(120) };

const SESSION: Session = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  cwd: "/srv/demo/work",
  cwdReal: "/srv/demo/work",
  cwdDev: 1,
  cwdIno: 1,
  piSessionId: "pi_demo",
  sessionFile: "/srv/demo/data/sessions/pi_demo.jsonl",
  confirmTools: [],
  modelSelection: MODEL,
  modelSelectionVersion: 3,
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
      text: "这一条正文被截断（只返回了前 48KiB），用于验证 `/expand` 提示与分页读取。".repeat(3),
      truncated: true,
      totalBytes: 96 * 1024,
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
  ];
}

/** 覆盖全部事件类型的事件流（seq 从 1 连续递增）。 */
function demoEvents(): PersistentEvent[] {
  const bodies: PersistentEventBody[] = [
    { type: "backend.started", dataDir: "/srv/demo/data", executionBackend: "container" },
    { type: "project.created", projectId: PROJECT_ID, name: PROJECT.name },
    { type: "session.created", sessionId: SESSION_ID, projectId: PROJECT_ID, cwd: SESSION.cwd, modelSelection: MODEL, modelSelectionVersion: 1 },
    { type: "session.model_selection_changed", sessionId: SESSION_ID, modelSelection: MODEL, modelSelectionVersion: 3 },
    { type: "task.queued", taskId: "task_completed000", sessionId: SESSION_ID, requestId: "req-1", accessMode: "full_access", modelSelection: MODEL },
    { type: "task.started", taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "task.output_fragment", taskId: "task_completed000", sessionId: SESSION_ID, messageId: "msg_1", text: "我先读一下布局代码…", totalBytes: 20, truncated: false, partial: true },
    { type: "task.tool_intent", taskId: "task_completed000", toolOpId: "toolop_demo000001", sdkCallId: "call_1", toolName: "read", params: { path: "src/tui/app.ts" } },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000001", summary: "读取 1660 行", isError: false, artifactIds: [] },
    { type: "task.tool_result", taskId: "task_completed000", toolOpId: "toolop_demo000002", summary: "命令失败：退出码 1", isError: true, artifactIds: ["art_demo0000000001"] },
    { type: "task.tool_effect_unknown", taskId: "task_interrupt00", toolOpId: "toolop_demo000003", toolName: "bash" },
    { type: "task.output_entry", taskId: "task_completed000", sessionId: SESSION_ID, entryId: "entry_0002", sessionFile: SESSION.sessionFile!, role: "assistant", messageId: "msg_1" },
    { type: "task.completed", taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "task.queued", taskId: "task_awaiting0000", sessionId: SESSION_ID, requestId: "req-2", accessMode: "confirm", modelSelection: MODEL },
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
    },
    { type: "task.confirmation_resolved", taskId: "task_awaiting0000", confirmationId: "conf_old000000000", decision: "rejected" },
    { type: "task.approval_consumed", taskId: "task_completed000", confirmationId: "conf_old000000001", toolOpId: "toolop_demo000001", toolName: "read" },
    { type: "task.mode_switch_requested", taskId: "task_running000000", sessionId: SESSION_ID, from: "confirm", to: "full_access" },
    { type: "task.mode_switched", taskId: "task_running000000", sessionId: SESSION_ID, from: "confirm", to: "full_access", permissionVersion: 2 },
    { type: "task.mode_switch_failed", taskId: "task_failed00000", sessionId: SESSION_ID, to: "full_access", reason: "任务已结束" },
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
    { type: "github.binding_changed", bindingId: "bind_demo0000000", projectId: PROJECT_ID, apiHost: "api.github.com", owner: "demo", repo: "demo-repo", configVersion: 2, action: "upsert" },
    { type: "github.draft_saved", draftId: "draft_demo000000", version: 1, taskId: "task_completed000", sessionId: SESSION_ID, kind: "pr_review_comment", bodySha256: "a".repeat(64), bodyBytes: 2048 },
    { type: "github.draft_stale", draftId: "draft_demo000000", version: 1, reason: "PR head SHA 已变化" },
    { type: "github.publish_requested", publishOpId: "pub_demo00000000", draftId: "draft_demo000000", draftVersion: 1, taskId: "task_completed000", sessionId: SESSION_ID },
    { type: "github.publish_settled", publishOpId: "pub_demo00000000", draftId: "draft_demo000000", status: "effect_unknown", remoteUrl: null, errorMessage: "发送后超时" },
    { type: "tasks.model_selection_recorded", sessionId: SESSION_ID, taskIds: ["task_queued000000"], modelSelection: MODEL },
    { type: "backend.recovered", interruptedTaskIds: ["task_interrupt00"], pausedSessionIds: [SESSION_ID] },
    { type: "backend.stopping", reason: "signal_sigterm" },
    { type: "backend.stopped", reason: "signal_sigterm" },
  ];
  return bodies.map((body, i) => ({
    seq: i + 1,
    taskId: "taskId" in body ? (body.taskId as string) : null,
    sessionId: "sessionId" in body ? (body.sessionId as string) : null,
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
  const eventListeners = new Set<(event: PersistentEvent) => void>();
  const closeListeners = new Set<(info: { reason: string; willRetry: boolean }) => void>();
  let closed = false;
  let cursor = 0;
  let timer: NodeJS.Timeout | null = null;

  const snapshot = (): ConnectResult["snapshot"] => ({
    projects: [PROJECT],
    sessions: [SESSION],
    tasks: demoTasks(),
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
          const page: HistoryPage = { fileAvailable: true, hasPartialTail: false, entries, nextBefore: null };
          void params;
          return reply(page);
        }
        case "read_history_entry": {
          const found = entries.find((e) => e.entryId === params?.["entry_id"]);
          if (!found) throw new Error(`合成会话：未知条目 ${String(params?.["entry_id"])}`);
          return reply(found);
        }
        case "get_task": {
          const found = demoTasks().find((t) => t.id === params?.["task_id"]);
          if (!found) throw new Error(`合成会话：未知任务 ${String(params?.["task_id"])}`);
          return reply({ task: found, outputPreview: null });
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
        default:
          // 写操作在合成会话里一律拒绝：它不该产生真实副作用
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
