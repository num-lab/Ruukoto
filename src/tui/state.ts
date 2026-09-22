/**
 * TUI 视图状态：快照与事件的应用、会话级展示数据。
 *
 * 设计分界：
 * -  transcript（消息记录）：来自历史读取接口的已落盘条目（唯一权威历史的
 *    投影），整页加载/向前翻页/按条目补齐；不回滚、不从事件补造正文；
 * -  activity（当前活动）：运行中/已中断任务的输出预览、工具记录与临时提示，
 *    来自快照 previews 与实时事件；任务结束并落盘后内容进入历史，活动区清空；
 * - 补发事件（replay）不改变任务状态：状态以快照为准，显示记录以历史重载
 *    为准（本模块据此忽略 replay 的状态改写）。
 *
 * 本模块不导入 pi-tui，可无终端测试。
 */

import type {
  AccessMode,
  ModelSelection,
  Artifact,
  PersistentEvent,
  Project,
  Session,
  Task,
  TaskStatus,
} from "../core/types.ts";
import { ACTIVE_TASK_STATUSES } from "../core/types.ts";
import type { ConnectResult } from "../control/protocol.ts";
import type { ConfirmationRequestView, OutputPreview } from "../core/views.ts";
import type { HistoryEntryView, HistoryPage } from "../core/history.ts";
import type { PendingRequest } from "../control/pending-requests.ts";

/** 每个会话在内存中保留的已加载历史条目上限（超出丢弃最旧；原文可翻页找回）。 */
export const MAX_LOADED_ENTRIES = 300;

export type TranscriptItem =
  | {
      kind: "message";
      entryId: string;
      role: string;
      text: string;
      truncated: boolean;
      totalBytes: number;
      timestamp: string;
      toolCalls: Array<{ toolCallId: string; toolName: string }>;
      hasNonTextContent: boolean;
    }
  | {
      kind: "toolEntry";
      entryId: string;
      toolName: string;
      toolCallId: string;
      isError: boolean;
      text: string;
      truncated: boolean;
      totalBytes: number;
      timestamp: string;
    };

export interface ToolRecord {
  toolOpId: string;
  taskId: string;
  toolName: string;
  sdkCallId: string | null;
  paramsPreview: Record<string, unknown>;
  paramsTruncated: boolean;
  status: "running" | "done" | "error" | "effect_unknown";
  resultSummary: string | null;
  artifactIds: string[];
}

export interface ActivityNote {
  key: string;
  text: string;
  at: string;
}

export interface SessionView {
  sessionId: string;
  projectId: string;
  cwd: string;
  queueState: "active" | "paused";
  queuePauseReason: string | null;
  /** 已加载历史窗口（旧 → 新）。 */
  transcript: TranscriptItem[];
  loadedEntryIds: Set<string>;
  /** 向前翻页游标（更老）；null = 已到顶或未加载。 */
  historyCursor: string | null;
  historyLoaded: boolean;
  /** 因内存窗口上限丢弃过更旧条目（仍可翻页找回）。 */
  trimmedOlder: boolean;
  hasPartialTail: boolean;
  /** 当前/最近任务的输出预览（生成中或中断前捕获）。 */
  preview: (OutputPreview & { taskId: string }) | null;
  /** 预览对应的事件序号（防止旧片段覆盖新预览）。 */
  previewSeq: number;
  tools: ToolRecord[];
  notes: ActivityNote[];
  draft: string;
  /** 离开时的滚动位置（null = 跟随底部）。 */
  scrollTop: number | null;
}

export interface ConnectionInfo {
  state: "connecting" | "online" | "reconnecting" | "failed" | "closed";
  detail: string | null;
  lastSyncAt: Date | null;
}

function entryToTranscriptItem(view: HistoryEntryView): TranscriptItem {
  if (view.role === "toolResult") {
    return {
      kind: "toolEntry",
      entryId: view.entryId,
      toolName: view.toolName ?? "unknown",
      toolCallId: view.toolCallId ?? "",
      isError: view.isError ?? false,
      text: view.text,
      truncated: view.truncated,
      totalBytes: view.totalBytes,
      timestamp: view.timestamp,
    };
  }
  return {
    kind: "message",
    entryId: view.entryId,
    role: view.role,
    text: view.text,
    truncated: view.truncated,
    totalBytes: view.totalBytes,
    timestamp: view.timestamp,
    toolCalls: view.toolCalls,
    hasNonTextContent: view.hasNonTextContent,
  };
}

export class ViewState {
  projects: Project[] = [];
  sessions: Session[] = [];
  tasks = new Map<string, Task>();
  confirmations: ConfirmationRequestView[] = [];
  artifacts = new Map<string, Artifact>();
  instanceId: string | null = null;
  execution: { backend: string; note: string } = { backend: "", note: "" };
  defaultModel: { provider: string; id: string; name: string; thinkingLevel: string } = {
    provider: "",
    id: "",
    name: "",
    thinkingLevel: "",
  };
  connection: ConnectionInfo = { state: "connecting", detail: null, lastSyncAt: null };
  sessionViews = new Map<string, SessionView>();
  currentSessionId: string | null = null;
  /** 待核实输入（应答丢失的提交）。 */
  pendingInputs: PendingRequest[] = [];
  corruptPendingFiles: string[] = [];
  /** 全局提示（尚未选择会话时展示）。 */
  globalNotes: ActivityNote[] = [];
  /** 快照中的任务预览（按任务）；会话视图打开时应用。 */
  private snapshotPreviews = new Map<string, OutputPreview>();
  private noteCounter = 0;

  // ---------- 快照 ----------

  /** 安装快照；instanceChanged 时丢弃全部会话视图（历史属于旧数据实例）。 */
  applySnapshot(result: ConnectResult, instanceChanged: boolean): void {
    this.projects = result.snapshot.projects;
    this.sessions = result.snapshot.sessions;
    this.tasks = new Map(result.snapshot.tasks.map((t) => [t.id, t]));
    this.confirmations = result.snapshot.confirmations;
    this.artifacts = new Map(result.snapshot.artifacts.map((a) => [a.id, a]));
    this.instanceId = result.snapshot.instanceId;
    this.execution = result.snapshot.execution;
    this.defaultModel = result.snapshot.defaultModel ?? this.defaultModel;
    if (instanceChanged) {
      this.sessionViews.clear();
      this.currentSessionId = null;
    }
    // 同步会话结构字段与预览
    for (const session of this.sessions) {
      const view = this.sessionViews.get(session.id);
      if (view) {
        view.projectId = session.projectId;
        view.cwd = session.cwd;
        view.queueState = session.queueState;
        view.queuePauseReason = session.queuePauseReason;
      }
    }
    // 预览先按任务登记；已打开的会话视图立即应用，未打开的随 openSession 应用
    this.snapshotPreviews = new Map(Object.entries(result.snapshot.previews));
    for (const [taskId, preview] of this.snapshotPreviews) {
      const task = this.tasks.get(taskId);
      if (!task) continue;
      const view = this.sessionViews.get(task.sessionId);
      if (!view) continue;
      if (preview.seq >= view.previewSeq) {
        view.preview = { ...preview, taskId };
        view.previewSeq = preview.seq;
      }
    }
  }

  // ---------- 事件 ----------

  /**
   * 应用事件。replay（补发）只用于补齐显示记录，不允许把状态回滚到旧值；
   * 本实现的状态以快照为准、显示记录以历史重载为准，因此 replay 不改变
   * 任务/审批状态。
   */
  applyEvent(event: PersistentEvent, kind: "live" | "replay"): void {
    const body = event.body;
    if (kind === "live") this.applyStateEvent(event);
    this.applyDisplayEvent(event, kind);
  }

  /** 状态事件：仅 live 应用（replay 的状态以快照为最新）。 */
  private applyStateEvent(event: PersistentEvent): void {
    const body = event.body;
    switch (body.type) {
      case "project.created":
        if (!this.projects.some((p) => p.id === body.projectId)) {
          this.projects.push({ id: body.projectId, name: body.name, instructionFiles: [], createdAt: event.createdAt });
        }
        return;
      case "session.created":
        if (!this.sessions.some((s) => s.id === body.sessionId)) {
          this.sessions.push({
            id: body.sessionId,
            projectId: body.projectId,
            cwd: body.cwd,
            cwdReal: body.cwd,
            cwdDev: 0,
            cwdIno: 0,
            piSessionId: "",
            sessionFile: null,
            confirmTools: [],
            modelSelection: body.modelSelection,
            modelSelectionVersion: body.modelSelectionVersion,
            defaultAccessMode: "confirm",
            defaultAccessModeVersion: 0,
            queueState: "active",
            queuePauseReason: null,
            createdAt: event.createdAt,
          });
        }
        return;
      case "task.queued":
        this.upsertTask({
          id: body.taskId,
          sessionId: body.sessionId,
          requestId: body.requestId,
          input: "",
          modelSelection: body.modelSelection,
          submissionDigest: null,
          status: "queued",
          accessMode: body.accessMode,
          permissionVersion: 1,
          grantedPaths: [],
          pendingAccessMode: null,
          interruptReason: null,
          cancelRequested: false,
          effectUnknown: false,
          errorMessage: null,
          historyEntryIds: [],
          resumesTaskId: null,
          createdAt: event.createdAt,
          startedAt: null,
          endedAt: null,
        });
        return;
      case "session.model_selection_changed":
        this.applySessionModel(body.sessionId, body.modelSelection, body.modelSelectionVersion);
        return;
      case "session.default_mode_changed":
        this.applySessionDefaultMode(body.sessionId, body.defaultAccessMode, body.defaultAccessModeVersion);
        return;
      case "tasks.model_selection_recorded":
        for (const taskId of body.taskIds) this.patchTask(taskId, { modelSelection: body.modelSelection });
        return;
      case "task.started":
        this.patchTask(body.taskId, { status: "running", startedAt: event.createdAt });
        return;
      case "task.completed":
        this.patchTask(body.taskId, { status: "completed", endedAt: event.createdAt });
        this.noteForTask(body.taskId, "任务已完成");
        return;
      case "task.failed":
        this.patchTask(body.taskId, { status: "failed", endedAt: event.createdAt, errorMessage: body.errorMessage });
        this.noteForTask(body.taskId, `任务失败：${body.errorMessage}`);
        return;
      case "task.canceled":
        this.patchTask(body.taskId, { status: "canceled", endedAt: event.createdAt, cancelRequested: true });
        this.noteForTask(body.taskId, "任务已取消");
        return;
      case "task.interrupted":
        this.patchTask(body.taskId, {
          status: "interrupted",
          endedAt: event.createdAt,
          interruptReason: body.reason,
          cancelRequested: body.cancelRequested,
          effectUnknown: body.effectUnknown,
        });
        this.noteForTask(
          body.taskId,
          `任务已中断（${body.reason}）${body.effectUnknown ? "；存在效果未知的工具操作，不能当作可安全重试" : ""}`,
        );
        return;
      case "task.continued": {
        const resumed = this.tasks.get(body.resumesTaskId);
        this.patchTask(body.taskId, { resumesTaskId: body.resumesTaskId });
        if (resumed) this.noteForTask(body.taskId, `继续自中断任务 ${body.resumesTaskId}`);
        return;
      }
      case "task.mode_switch_requested":
        this.patchTask(body.taskId, { pendingAccessMode: body.to });
        return;
      case "task.mode_switched":
        this.patchTask(body.taskId, {
          accessMode: body.to,
          pendingAccessMode: null,
          permissionVersion: body.permissionVersion,
        });
        this.noteForTask(body.taskId, `访问模式已生效：${body.to}（权限版本 ${body.permissionVersion}）`);
        return;
      case "task.mode_switch_failed":
        this.patchTask(body.taskId, { pendingAccessMode: null });
        this.noteForTask(body.taskId, `模式切换失败：${body.reason}`);
        return;
      case "task.awaiting_confirmation": {
        if (!this.confirmations.some((c) => c.id === body.confirmationId)) {
          this.confirmations.push({
            id: body.confirmationId,
            taskId: body.taskId,
            sessionId: this.tasks.get(body.taskId)?.sessionId ?? "",
            toolOpId: body.toolOpId,
            toolName: body.toolName,
            params: body.params,
            paramsBytes: body.paramsBytes ?? Buffer.byteLength(JSON.stringify(body.params), "utf8"),
            paramsTruncated: body.paramsTruncated ?? false,
            scope: body.scope,
            cwdDev: 0,
            cwdIno: 0,
            permissionVersion: body.permissionVersion ?? 0,
            status: "pending",
            createdAt: event.createdAt,
            respondedAt: null,
            consumedAt: null,
            reviewStatus: body.reviewStatus ?? null,
            reviewDecision: null,
            reviewReason: null,
            reviewModel: body.reviewModel ?? null,
            reviewPolicyVersion: body.reviewPolicyVersion ?? null,
            decisionSource: null,
          });
          // 新审批提示（不抢输入焦点；计数同时显示在状态行）
          this.note(
            this.tasks.get(body.taskId)?.sessionId ?? null,
            `新审批请求：${body.toolName}（/approvals 查看详情；审批只在详情页内操作）`,
          );
        }
        return;
      }
      case "task.confirmation_resolved": {
        const resolved = this.confirmations.find((c) => c.id === body.confirmationId);
        this.confirmations = this.confirmations.filter((c) => c.id !== body.confirmationId);
        // 自动审查的决定提示来源与理由（人工决定沿用现有行为，不额外提示）
        if (body.source === "auto_review") {
          this.note(
            resolved?.sessionId ?? this.tasks.get(body.taskId)?.sessionId ?? null,
            `自动审查已${body.decision === "approved" ? "批准" : "拒绝"}：${body.reason ?? ""}（${resolved?.toolName ?? body.confirmationId}）`,
          );
        }
        return;
      }
      case "task.confirmation_reviewed": {
        // 自动审查转人工：审批仍 pending，更新审查状态并提示原因
        const view = this.confirmations.find((c) => c.id === body.confirmationId);
        if (view) {
          view.reviewStatus = "asked_owner";
          view.reviewDecision = "ask_owner";
          view.reviewReason = body.reason;
        }
        this.noteForTask(body.taskId, `自动审查转人工：${body.reason}`);
        return;
      }
      case "session.queue_paused": {
        const session = this.sessions.find((s) => s.id === body.sessionId);
        if (session) {
          session.queueState = "paused";
          session.queuePauseReason = body.reason;
        }
        const view = this.sessionViews.get(body.sessionId);
        if (view) {
          view.queueState = "paused";
          view.queuePauseReason = body.reason;
        }
        this.note(body.sessionId, `队列已暂停（${body.reason}）；核实后可经 /resume-queue 恢复`);
        return;
      }
      case "session.queue_resumed": {
        const session = this.sessions.find((s) => s.id === body.sessionId);
        if (session) {
          session.queueState = "active";
          session.queuePauseReason = null;
        }
        const view = this.sessionViews.get(body.sessionId);
        if (view) {
          view.queueState = "active";
          view.queuePauseReason = null;
        }
        return;
      }
      case "session.history_unreadable":
        this.note(body.sessionId, `历史读取异常：${body.error}`);
        return;
      case "github.draft_saved":
        this.note(body.sessionId, `GitHub 草稿已保存：${body.draftId.slice(0, 12)} v${body.version}（${body.kind}，${body.bodyBytes} 字节）——/github show ${body.draftId.slice(0, 12)} 查看`);
        return;
      case "github.draft_stale":
        this.note(null, `GitHub 草稿 ${body.draftId.slice(0, 12)} v${body.version} 已标记过时：${body.reason}`);
        return;
      case "github.publish_requested":
        this.note(body.sessionId, `GitHub 发布已请求：${body.publishOpId.slice(0, 12)}（草稿 ${body.draftId.slice(0, 12)} v${body.draftVersion}）`);
        return;
      case "github.publish_settled": {
        const text =
          body.status === "sent"
            ? `GitHub 发布完成：${body.remoteUrl ?? body.publishOpId.slice(0, 12)}`
            : body.status === "effect_unknown"
              ? `GitHub 发布结果未知（${body.errorMessage ?? ""}）：不会自动重发，请人工核实远端`
              : `GitHub 发布${body.status === "failed" ? "失败" : "取消"}：${body.errorMessage ?? ""}`;
        this.note(null, text);
        return;
      }
      case "github.binding_changed":
        this.note(null, `GitHub 仓库绑定${body.action === "removed" ? "已撤销" : "已更新"}：${body.owner}/${body.repo}（配置版本 ${body.configVersion}）`);
        return;
      case "backend.stopping":
      case "backend.stopped":
        // 连接会随即断开；状态由连接层展示
        return;
      default:
        return;
    }
  }

  /** 显示事件：live 与 replay 都应用（带序号防护，不允许旧片段覆盖新预览）。 */
  private applyDisplayEvent(event: PersistentEvent, kind: "live" | "replay"): void {
    const body = event.body;
    switch (body.type) {
      case "task.output_fragment": {
        const view = this.sessionViews.get(body.sessionId);
        if (!view) return;
        // 序号防护：任何更旧的片段（含 replay 的其他消息）都不得覆盖更新的预览
        if (event.seq < view.previewSeq) return;
        view.preview = {
          messageId: body.messageId,
          text: body.text,
          totalBytes: body.totalBytes,
          truncated: body.truncated,
          seq: event.seq,
          state: "generating",
          taskId: body.taskId,
        };
        view.previewSeq = event.seq;
        return;
      }
      case "task.output_entry": {
        // 最终条目落盘：取代对应预览；正文经历史读取补齐（app 层取回后
        // 调 appendEntryView）。预览清除先于正文到达，避免重复显示。
        const view = this.sessionViews.get(body.sessionId);
        if (view?.preview && body.messageId && view.preview.messageId === body.messageId) {
          view.preview = null;
        }
        return;
      }
      case "task.tool_intent": {
        const view = (event.sessionId && this.sessionViews.get(event.sessionId)) || viewForTask(this.sessionViews, body.taskId);
        if (!view) return;
        if (!view.tools.some((t) => t.toolOpId === body.toolOpId)) {
          view.tools.push({
            toolOpId: body.toolOpId,
            taskId: body.taskId,
            toolName: body.toolName,
            sdkCallId: body.sdkCallId,
            paramsPreview: body.params,
            paramsTruncated: body.paramsTruncated ?? false,
            status: "running",
            resultSummary: null,
            artifactIds: [],
          });
        }
        return;
      }
      case "task.tool_result": {
        const view = (event.sessionId && this.sessionViews.get(event.sessionId)) || viewForTask(this.sessionViews, body.taskId);
        const tool = view?.tools.find((t) => t.toolOpId === body.toolOpId);
        if (tool) {
          tool.status = body.isError ? "error" : "done";
          tool.resultSummary = body.summary;
          tool.artifactIds = body.artifactIds;
        }
        return;
      }
      case "task.tool_effect_unknown": {
        const view = (event.sessionId && this.sessionViews.get(event.sessionId)) || viewForTask(this.sessionViews, body.taskId);
        const tool = view?.tools.find((t) => t.toolOpId === body.toolOpId);
        if (tool) tool.status = "effect_unknown";
        return;
      }
      default:
        return;
    }
  }

  // ---------- 会话视图 ----------

  /** 打开/取得会话视图（首次创建空视图；历史由 app 层经 read_history 加载）。 */
  openSession(sessionId: string): SessionView {
    let view = this.sessionViews.get(sessionId);
    if (!view) {
      const session = this.sessions.find((s) => s.id === sessionId);
      view = {
        sessionId,
        projectId: session?.projectId ?? "",
        cwd: session?.cwd ?? "",
        queueState: session?.queueState ?? "active",
        queuePauseReason: session?.queuePauseReason ?? null,
        transcript: [],
        loadedEntryIds: new Set(),
        historyCursor: null,
        historyLoaded: false,
        trimmedOlder: false,
        hasPartialTail: false,
        preview: null,
        previewSeq: 0,
        tools: [],
        notes: [],
        draft: "",
        scrollTop: null,
      };
      this.sessionViews.set(sessionId, view);
      // 应用快照中属于本会话任务的预览（快照先于视图打开到达的情况）
      for (const [taskId, preview] of this.snapshotPreviews) {
        const task = this.tasks.get(taskId);
        if (task?.sessionId === sessionId && preview.seq >= view.previewSeq) {
          view.preview = { ...preview, taskId };
          view.previewSeq = preview.seq;
        }
      }
    }
    return view;
  }

  /** 安装历史页：replace（初次/重同步）或 prepend（向前翻页）。 */
  installHistoryPage(sessionId: string, page: HistoryPage, mode: "replace" | "prepend"): void {
    const view = this.openSession(sessionId);
    const items = page.entries
      .filter((e) => !view.loadedEntryIds.has(e.entryId))
      .map(entryToTranscriptItem);
    if (mode === "replace") {
      view.transcript = items;
      view.loadedEntryIds = new Set(page.entries.map((e) => e.entryId));
      view.trimmedOlder = false;
    } else {
      view.transcript = [...items, ...view.transcript];
      for (const e of page.entries) view.loadedEntryIds.add(e.entryId);
    }
    view.historyCursor = page.nextBefore;
    view.historyLoaded = true;
    view.hasPartialTail = page.hasPartialTail;
    this.trimTranscript(view);
  }

  /** 单个落盘条目的增量补齐（output_entry 事件驱动；去重）。 */
  appendEntryView(sessionId: string, entry: HistoryEntryView): boolean {
    const view = this.openSession(sessionId);
    if (view.loadedEntryIds.has(entry.entryId)) return false;
    view.loadedEntryIds.add(entry.entryId);
    view.transcript.push(entryToTranscriptItem(entry));
    // 落盘的 toolResult 条目取代活动区的同名工具记录（避免重复显示）
    if (entry.role === "toolResult" && entry.toolCallId) {
      view.tools = view.tools.filter((t) => t.sdkCallId !== entry.toolCallId);
    }
    this.trimTranscript(view);
    return true;
  }

  private trimTranscript(view: SessionView): void {
    if (view.transcript.length <= MAX_LOADED_ENTRIES) return;
    const drop = view.transcript.length - MAX_LOADED_ENTRIES;
    view.transcript.splice(0, drop);
    view.trimmedOlder = true;
    // 丢弃最旧条目后，以其后第一条为翻页锚点（read_history before=锚点 可找回被丢弃的条目）
    view.historyCursor = view.transcript[0]?.kind === "message" || view.transcript[0]?.kind === "toolEntry"
      ? (view.transcript[0] as { entryId: string }).entryId
      : view.historyCursor;
  }

  // ---------- 查询 ----------

  applySessionModel(sessionId: string, selection: ModelSelection | null, version: number): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && version >= session.modelSelectionVersion) {
      session.modelSelection = selection;
      session.modelSelectionVersion = version;
    }
  }

  applySessionDefaultMode(sessionId: string, mode: AccessMode, version: number): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && version >= session.defaultAccessModeVersion) {
      session.defaultAccessMode = mode;
      session.defaultAccessModeVersion = version;
    }
  }

  upsertTask(task: Task): void {
    this.tasks.set(task.id, task);
  }

  private patchTask(taskId: string, patch: Partial<Task>): void {
    const task = this.tasks.get(taskId);
    if (task) Object.assign(task, patch);
  }

  getTask(taskId: string): Task | null {
    return this.tasks.get(taskId) ?? null;
  }

  tasksFor(sessionId: string): Task[] {
    return [...this.tasks.values()]
      .filter((t) => t.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  activeTaskFor(sessionId: string): Task | null {
    const actives = this.tasksFor(sessionId).filter((t) => t.status === "running" || t.status === "awaiting_confirmation");
    return actives.at(-1) ?? null;
  }

  queuedTasksFor(sessionId: string): Task[] {
    return this.tasksFor(sessionId).filter((t) => t.status === "queued");
  }

  pendingApprovals(): ConfirmationRequestView[] {
    return this.confirmations.filter((c) => c.status === "pending");
  }

  projectName(projectId: string): string {
    return this.projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  private noteForTask(taskId: string, text: string): void {
    const task = this.tasks.get(taskId);
    this.note(task?.sessionId ?? null, text);
  }

  note(sessionId: string | null, text: string): void {
    const note = { key: `note-${++this.noteCounter}`, text, at: new Date().toISOString() };
    if (!sessionId) {
      this.globalNotes.push(note);
      if (this.globalNotes.length > 8) this.globalNotes.splice(0, this.globalNotes.length - 8);
      return;
    }
    const view = this.sessionViews.get(sessionId);
    if (!view) {
      // 会话视图尚未打开：提示进入全局列表，不丢失
      this.globalNotes.push(note);
      return;
    }
    view.notes.push(note);
    if (view.notes.length > 8) view.notes.splice(0, view.notes.length - 8);
  }
}

function viewForTask(views: Map<string, SessionView>, taskId: string): SessionView | undefined {
  for (const view of views.values()) {
    if (view.tools.some((t) => t.taskId === taskId)) return view;
  }
  return undefined;
}

/** 访问模式显示名（/mode 列表、状态栏、模式提示共用）。 */
export function accessModeLabel(mode: AccessMode): string {
  switch (mode) {
    case "full_access":
      return "完全访问";
    case "auto-review":
      return "自动审查";
    default:
      return "Ask for approval";
  }
}

export function formatAccessMode(mode: AccessMode, pending: AccessMode | null): string {
  const base = accessModeLabel(mode);
  return pending ? `${base}（待切换：${accessModeLabel(pending)}）` : base;
}

export function formatTaskStatus(status: TaskStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "awaiting_confirmation":
      return "等待审批";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "canceled":
      return "已取消";
    case "interrupted":
      return "已中断";
  }
}

export function isActiveStatus(status: TaskStatus): boolean {
  return (ACTIVE_TASK_STATUSES as readonly TaskStatus[]).includes(status);
}
