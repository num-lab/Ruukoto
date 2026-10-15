import type { TaskView as Task } from "@ruukoto/core/views.ts";
/** 控制面状态与会话交互状态；事件展示统一交给 EventFlow 投影。 */
// Note: 见 .agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md

import type {
  AccessMode,
  SessionDefaultMode,
  ModelSelection,
  Artifact,
  PersistentEvent,
  Project,
  Session,
  SubAgent,
  SubAgentState,
  TaskStatus,
  WorkDelegation,
} from "@ruukoto/core/types.ts";
import { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "@ruukoto/core/task-status.ts";
import type { ConnectResult } from "@ruukoto/control/protocol.ts";
import type { ConfirmationRequestView, OutputPreview, ToolOpView } from "@ruukoto/core/views.ts";
import type { HistoryEntryView, HistoryPage } from "@ruukoto/core/history.ts";
import type { PendingRequest } from "@ruukoto/control/pending-requests.ts";
import { EventFlow } from "./event-flow.ts";
import { utf8ByteLength } from "./utf8.ts";
import { sessionDisplayAttribution } from "@ruukoto/control/session-attribution.ts";

/** 每个会话在内存中保留的已加载历史条目上限（超出丢弃最旧；原文可翻页找回）。 */
export const MAX_LOADED_ENTRIES = 300;

export interface ActivityNote { key: string; text: string; at: string }

export interface SessionView {
  sessionId: string;
  projectId: string;
  cwd: string;
  queueState: "active" | "paused";
  queuePauseReason: string | null;
  flow: EventFlow;
  historyCursor: string | null;
  historyLoaded: boolean;
  trimmedOlder: boolean;
  hasPartialTail: boolean;
  draft: string;
  scrollTop: number | null;
}

export interface ConnectionInfo {
  state: "connecting" | "online" | "reconnecting" | "failed" | "closed";
  detail: string | null;
  lastSyncAt: Date | null;
}

export class ViewState {
  projects: Project[] = [];
  sessions: Session[] = [];
  tasks = new Map<string, Task>();
  confirmations: ConfirmationRequestView[] = [];
  artifacts = new Map<string, Artifact>();
  instanceId: string | null = null;
  execution: { backend: string; note: string } = { backend: "", note: "" };
  /** 逻辑角色绑定的会话（快照提供；角色只在后台启动时引导，不随事件新增）。 */
  roleSessionIds: string[] = [];
  /** SubAgent 的内部工作会话（快照 + work_delegation.created 事件补齐；普通工作区入口排除）。 */
  subAgentSessionIds: string[] = [];
  /** 工作委托（issue 11；快照 + work_delegation.created 事件补齐）。 */
  workDelegations: WorkDelegation[] = [];
  /** 动态 SubAgent 身份（快照 + 委派事件补齐；状态以快照为准）。 */
  subAgents: SubAgent[] = [];
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
  private taskSeq = new Map<string, number>();
  private noteCounter = 0;

  // ---------- 快照 ----------

  /** 安装快照；instanceChanged 时丢弃全部会话视图（历史属于旧数据实例）。 */
  applySnapshot(result: ConnectResult, instanceChanged: boolean): void {
    this.projects = result.snapshot.projects;
    this.sessions = result.snapshot.sessions;
    this.tasks = new Map(result.snapshot.tasks.map((t) => [t.id, t]));
    this.taskSeq = new Map(result.snapshot.tasks.map((t) => [t.id, result.seq]));
    this.confirmations = result.snapshot.confirmations;
    this.artifacts = new Map(result.snapshot.artifacts.map((a) => [a.id, a]));
    this.instanceId = result.snapshot.instanceId;
    this.execution = result.snapshot.execution;
    this.defaultModel = result.snapshot.defaultModel ?? this.defaultModel;
    this.roleSessionIds = result.snapshot.roleSessionIds ?? [];
    this.subAgentSessionIds = result.snapshot.subAgentSessionIds ?? [];
    this.workDelegations = result.snapshot.workDelegations ?? [];
    this.subAgents = result.snapshot.subAgents ?? [];
    if (instanceChanged) {
      this.sessionViews.clear();
      this.currentSessionId = null;
    }
    this.snapshotPreviews = new Map(Object.entries(result.snapshot.previews));
    for (const [sessionId, view] of this.sessionViews) {
      const session = this.sessions.find((item) => item.id === sessionId);
      if (!session) continue;
      view.projectId = session.projectId;
      view.cwd = session.cwd;
      view.queueState = session.queueState;
      view.queuePauseReason = session.queuePauseReason;
      view.flow.resetRemote();
      view.historyLoaded = false;
      for (const task of this.tasksFor(sessionId)) if (isActiveStatus(task.status)) view.flow.task(task);
      for (const [taskId, preview] of this.snapshotPreviews) {
        if (this.tasks.get(taskId)?.sessionId === sessionId) view.flow.preview(taskId, preview);
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
    if (kind === "live") {
      this.applyStateEvent(event);
      if ("taskId" in body && typeof body.taskId === "string") this.taskSeq.set(body.taskId, event.seq);
    }
    const sessionId = event.sessionId ?? ("sessionId" in body ? body.sessionId : null)
      ?? ("taskId" in body && typeof body.taskId === "string" ? this.tasks.get(body.taskId)?.sessionId : null);
    if (sessionId) {
      const view = this.openSession(sessionId);
      if ("taskId" in body && typeof body.taskId === "string") {
        const task = this.tasks.get(body.taskId);
        if (task?.sessionId === sessionId) view.flow.task(task);
      }
      view.flow.apply(event);
    }
  }

  /** 状态事件：仅 live 应用（replay 的状态以快照为最新）。 */
  private applyStateEvent(event: PersistentEvent): void {
    const body = event.body;
    switch (body.type) {
      case "agent_wait.changed":
        this.patchTask(body.taskId, { wait: body.wait, resourcePhase: body.phase === "waiting" || body.phase === "conversation" ? "conversation" : this.tasks.get(body.taskId)?.resourcePhase });
        return;
      case "task.resources_changed":
        this.patchTask(body.taskId, { resourcePhase: body.phase });
        return;
      case "agent_report.changed":
        if (body.fallbackTaskId) this.patchTask(body.fallbackTaskId, { reportParked: body.fallbackState === "parked" });
        for (const taskId of body.parkedFallbackTaskIds) this.patchTask(taskId, { reportParked: true });
        return;
      case "project.created":
        if (!this.projects.some((p) => p.id === body.projectId)) {
          this.projects.push({ id: body.projectId, name: body.name, createRequestId: body.createRequestId ?? null, rootDir: body.rootDir ?? null, instructionFiles: [], webSearch: "enabled", settingsVersion: 1, createdAt: event.createdAt });
        }
        return;
      case "project.root_attached": {
        const project = this.projects.find((p) => p.id === body.projectId);
        if (project && !project.rootDir) project.rootDir = body.rootDir;
        return;
      }
      case "project.settings_changed": {
        const project = this.projects.find((p) => p.id === body.projectId);
        if (project) {
          project.instructionFiles = body.instructionFiles;
          project.webSearch = body.webSearch;
          project.settingsVersion = body.settingsVersion;
        }
        return;
      }
      case "session.created":
        if (!this.sessions.some((s) => s.id === body.sessionId)) {
          this.sessions.push(body.session ?? {
            id: body.sessionId,
            name: null,
            branchSource: null,
            projectId: body.projectId,
            workspaceProjectId: null,
            kind: body.kind ?? "dev",
            cwd: body.cwd,
            cwdReal: body.cwd,
            cwdDev: 0,
            cwdIno: 0,
            piSessionId: "",
            sessionFile: null,
            confirmTools: [],
            createRequestId: body.createRequestId ?? null,
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
          inputPurpose: this.tasks.get(body.taskId)?.inputPurpose ?? "user",
          modelSelection: body.modelSelection,
          submissionDigest: null,
          status: "queued",
          accessMode: body.accessMode,
          planMode: body.planMode,
          permissionVersion: 1,
          sourcePermissionVersion: body.sourcePermissionVersion ?? null,
          grantedPaths: [],
          pendingAccessMode: null,
          interruptReason: null,
          cancelRequested: false,
          effectUnknown: false,
          errorMessage: null,
          historyEntryIds: [],
          resumesTaskId: null,
          agentId: null,
          parentTaskId: body.parentTaskId ?? null,
          sourceEventId: null,
          deadline: null,
          resultSummary: null,
          resultRef: null,
    workId: null, subAgentId: null, readScope: null, resultDeliveredAt: null,
          createdAt: event.createdAt,
          startedAt: null,
          endedAt: null,
        });
        return;
      case "session.workspace_mapped": {
        // agent-direction issue 07：仅组织展示归属；资料身份仍是 projectId
        const session = this.sessions.find((s) => s.id === body.sessionId);
        if (session) session.workspaceProjectId = body.workspaceProjectId;
        return;
      }
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
        // 不加提示行：结束已由转录区末尾的「耗时 … · 结束 …」标注
        this.patchTask(body.taskId, { status: "completed", endedAt: event.createdAt });
        return;
      case "task.failed":
        this.patchTask(body.taskId, { status: "failed", endedAt: event.createdAt, errorMessage: body.errorMessage });
        return;
      case "task.canceled":
        this.patchTask(body.taskId, { status: "canceled", endedAt: event.createdAt, cancelRequested: true });
        return;
      case "task.interrupted":
        this.patchTask(body.taskId, {
          status: "interrupted",
          endedAt: event.createdAt,
          interruptReason: body.reason,
          cancelRequested: body.cancelRequested,
          effectUnknown: body.effectUnknown,
        });
        return;
      case "task.continued": {
        const resumed = this.tasks.get(body.resumesTaskId);
        this.patchTask(body.taskId, { resumesTaskId: body.resumesTaskId });
        if (resumed) this.noteForTask(body.taskId, `继续自中断任务 ${body.resumesTaskId}`, event.createdAt);
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
        this.noteForTask(body.taskId, `访问模式已生效：${body.to}（权限版本 ${body.permissionVersion}）`, event.createdAt);
        return;
      case "task.mode_switch_failed":
        // 该事件只随 endTask 中断产生；已有终态不被迟到事件回滚。
        // Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
        if (!TERMINAL_TASK_STATUSES.includes(this.tasks.get(body.taskId)?.status ?? "interrupted")) {
          this.patchTask(body.taskId, { status: "interrupted", pendingAccessMode: null, endedAt: event.createdAt, interruptReason: "mode_switch_unverified" });
        }
        this.noteForTask(body.taskId, `模式切换失败：${body.reason}`, event.createdAt);
        return;
      case "task.awaiting_confirmation": {
        if (this.tasks.get(body.taskId)?.status === "running") this.patchTask(body.taskId, { status: "awaiting_confirmation" });
        if (!this.confirmations.some((c) => c.id === body.confirmationId)) {
          this.confirmations.push({
            id: body.confirmationId,
            taskId: body.taskId,
            sessionId: this.tasks.get(body.taskId)?.sessionId ?? "",
            toolOpId: body.toolOpId,
            toolName: body.toolName,
            params: body.params,
            paramsBytes: body.paramsBytes ?? utf8ByteLength(JSON.stringify(body.params)),
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
            standingPermissionId: null,
            standingPermissionVersion: null,
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
        if (this.tasks.get(body.taskId)?.status === "awaiting_confirmation" && !this.confirmations.some((c) => c.taskId === body.taskId && c.status === "pending")) {
          this.patchTask(body.taskId, { status: "running" });
        }
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
        this.noteForTask(body.taskId, `自动审查转人工：${body.reason}`, event.createdAt);
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
      case "work_delegation.created": {
        // issue 11：登记记录同步进状态（子会话立即排除出普通列表，不等重连快照）；
        // originTaskId/requestKey/paramsDigest 不在事件载荷里，置空且展示不引用
        if (!this.subAgentSessionIds.includes(body.agentSessionId)) this.subAgentSessionIds.push(body.agentSessionId);
        if (!this.workDelegations.some((w) => w.id === body.workId)) {
          this.workDelegations.push({
            id: body.workId,
            parentSessionId: body.parentSessionId,
            originTaskId: "",
            subAgentId: body.subAgentId,
            requestKey: "",
            paramsDigest: "",
            canceledAt: null,
            canceledBy: null,
            cancelReason: null,
            writeTarget: null,
            createdAt: event.createdAt,
          });
        }
        if (!this.subAgents.some((a) => a.id === body.subAgentId)) {
          this.subAgents.push({
            id: body.subAgentId,
            parentSessionId: body.parentSessionId,
            sessionId: body.agentSessionId,
            workDir: "",
            activeWorkId: body.workId,
            currentTaskId: body.taskId,
            state: "running",
            closedAt: null,
            closedBy: null,
            createdAt: event.createdAt,
          });
        } else {
          // 委派成功后台恒置 running + 当前任务（含同一 SubAgent 的新工作）
          const agent = this.subAgents.find((a) => a.id === body.subAgentId)!;
          Object.assign(agent, { state: "running", activeWorkId: body.workId, currentTaskId: body.taskId });
        }
        this.note(body.parentSessionId, `工作委托已登记：${body.workId.slice(0, 12)}…（SubAgent ${body.subAgentId.slice(0, 12)}…）`, event.createdAt);
        return;
      }
      case "subagent.closed": {
        const agent = this.subAgents.find((a) => a.id === body.subAgentId);
        if (agent) {
          agent.closedAt = event.createdAt;
          agent.closedBy = body.closedBy;
        }
        this.note(body.parentSessionId, `SubAgent 已关闭：${body.subAgentId.slice(0, 12)}…（历史与产物保留）`, event.createdAt);
        return;
      }
      case "work_delegation.canceled": {
        // issue 14：登记字段同步进状态；任务终态由各自 task.* / subagent_task.* 事件到达
        const work = this.workDelegations.find((w) => w.id === body.workId);
        if (work) {
          work.canceledAt = event.createdAt;
          work.canceledBy = body.canceledBy;
          work.cancelReason = body.reason;
        }
        this.note(
          body.parentSessionId,
          `工作委托已取消：${body.workId.slice(0, 12)}…（${body.canceledBy}${body.reason ? `，${body.reason}` : ""}；历史与产物保留，迟到结果不再送达）`,
          event.createdAt,
        );
        return;
      }
      case "work_delegation.integrated": {
        // issue 17：汇总只落事件（不想状态字段，TUI 按提示如实展示来源与规模）
        this.note(
          body.parentSessionId,
          `改动已汇总：工作 ${body.workId.slice(0, 12)}…（${body.filesChanged} 个文件，+${body.insertions}/-${body.deletions}；副本分支 ${body.branch}，基线 ${body.baseCommit.slice(0, 12)}${body.parentHead ? `，父 HEAD ${body.parentHead.slice(0, 12)}` : ""}）`,
          event.createdAt,
        );
        return;
      }
      case "subagent_task.completed":
      case "subagent_task.failed":
      case "subagent_task.timeout":
      case "subagent_task.result_unknown": {
        // 任务已终态（事件可证）；idle/unverified 之分取决于占用核实，以重连快照为准
        const agent = this.subAgents.find((a) => a.id === body.subAgentId);
        if (agent?.currentTaskId === body.taskId) agent.currentTaskId = null;
        const label = body.type === "subagent_task.completed" ? "完成" : body.type === "subagent_task.failed" ? "失败" : body.type === "subagent_task.timeout" ? "超时" : "结果未知";
        this.note(body.parentSessionId, `SubAgent 任务${label}：${body.workId.slice(0, 12)}…（SubAgent ${body.subAgentId.slice(0, 12)}…）`, event.createdAt);
        return;
      }
      // issue 17：github.* 事件已随专用模块退役，仅为历史事件重放的只读展示保留
      case "github.draft_saved":
        this.note(body.sessionId, `GitHub 草稿（历史记录）：${body.draftId.slice(0, 12)} v${body.version}（${body.kind}，${body.bodyBytes} 字节）`);
        return;
      case "github.draft_stale":
        this.note(null, `GitHub 草稿（历史记录）${body.draftId.slice(0, 12)} v${body.version} 已标记过时：${body.reason}`);
        return;
      case "github.publish_requested":
        this.note(body.sessionId, `GitHub 发布请求（历史记录）：${body.publishOpId.slice(0, 12)}（草稿 ${body.draftId.slice(0, 12)} v${body.draftVersion}）`);
        return;
      case "github.publish_settled": {
        const text =
          body.status === "sent"
            ? `GitHub 发布（历史记录）完成：${body.remoteUrl ?? body.publishOpId.slice(0, 12)}`
            : body.status === "effect_unknown"
              ? `GitHub 发布（历史记录）结果未知（${body.errorMessage ?? ""}）：不会自动重发，请人工核实远端`
              : `GitHub 发布（历史记录）${body.status === "failed" ? "失败" : "取消"}：${body.errorMessage ?? ""}`;
        this.note(null, text);
        return;
      }
      case "github.binding_changed":
        this.note(null, `GitHub 仓库绑定（历史记录）${body.action === "removed" ? "已撤销" : "已更新"}：${body.owner}/${body.repo}（配置版本 ${body.configVersion}）`);
        return;
      case "mcp.service_changed": {
        const action = body.action === "removed" ? "已移除" : body.action === "disabled" ? "已禁用" : body.action === "enabled" ? "已启用" : "已更新";
        this.note(null, `MCP 服务 ${body.name}（${body.endpoint}）${action}（配置版本 ${body.configVersion}）`);
        return;
      }
      case "mcp.service_unavailable":
        this.noteForTask(body.taskId, `MCP 服务 ${body.name}（${body.endpoint}）不可用：${body.reason}；本任务缺少其工具能力`, event.createdAt);
        return;
      case "backend.stopping":
      case "backend.stopped":
        // 连接会随即断开；状态由连接层展示
        return;
      default:
        return;
    }
  }

  // ---------- 会话视图 ----------

  openSession(sessionId: string): SessionView {
    let view = this.sessionViews.get(sessionId);
    if (view) return view;
    const session = this.sessions.find((item) => item.id === sessionId);
    view = {
      sessionId, projectId: session?.projectId ?? "", cwd: session?.cwd ?? "",
      queueState: session?.queueState ?? "active", queuePauseReason: session?.queuePauseReason ?? null,
      flow: new EventFlow(), historyCursor: null, historyLoaded: false, trimmedOlder: false,
      hasPartialTail: false, draft: "", scrollTop: null,
    };
    this.sessionViews.set(sessionId, view);
    if (session?.branchSource) {
      const source = session.branchSource;
      view.flow.note(`branch-source:${sessionId}`, `来源会话 ${source.sessionId} · 分支点 ${source.entryId} · ${source.messageCount} 条消息` +
        (source.excluded.length ? `；未纳入：${source.excluded.join("、")}` : ""), session.createdAt);
    }
    for (const task of this.tasksFor(sessionId)) if (isActiveStatus(task.status)) view.flow.task(task);
    for (const [taskId, preview] of this.snapshotPreviews) {
      if (this.tasks.get(taskId)?.sessionId === sessionId) view.flow.preview(taskId, preview);
    }
    return view;
  }

  installHistoryPage(sessionId: string, page: HistoryPage, mode: "replace" | "prepend"): void {
    const view = this.openSession(sessionId);
    const limit = mode === "prepend" ? Math.max(MAX_LOADED_ENTRIES, view.flow.historyEntries.length + page.entries.length) : MAX_LOADED_ENTRIES;
    const result = view.flow.installHistory(page.entries, mode === "replace", limit);
    view.historyCursor = result.trimmed ? result.firstId : page.nextBefore;
    view.trimmedOlder = result.trimmed;
    view.historyLoaded = true;
    view.hasPartialTail = page.hasPartialTail;
  }

  appendEntryView(sessionId: string, entry: HistoryEntryView): boolean {
    const view = this.openSession(sessionId);
    const count = view.flow.historyEntries.length;
    const result = view.flow.installHistory([entry], false, count > MAX_LOADED_ENTRIES ? count + 1 : MAX_LOADED_ENTRIES);
    if (result.trimmed) {
      view.trimmedOlder = true;
      view.historyCursor = result.firstId;
    }
    return true;
  }

  installTaskDetail(task: Task, tools: ToolOpView[], preview?: OutputPreview | null, seq = 0): void {
    if (seq >= (this.taskSeq.get(task.id) ?? 0)) {
      this.upsertTask(task);
      this.taskSeq.set(task.id, seq);
    } else {
      const current = this.tasks.get(task.id);
      if (current && !current.input && task.input) {
        current.input = task.input;
        current.inputPurpose = task.inputPurpose;
        this.sessionViews.get(task.sessionId)?.flow.task(current);
      }
    }
    const flow = this.openSession(task.sessionId).flow;
    for (const tool of tools) flow.tool(tool, seq);
    if (preview) flow.preview(task.id, preview);
  }

  // ---------- 查询 ----------

  applySessionModel(sessionId: string, selection: ModelSelection | null, version: number): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && version >= session.modelSelectionVersion) {
      session.modelSelection = selection;
      session.modelSelectionVersion = version;
    }
  }

  applySessionDefaultMode(sessionId: string, mode: SessionDefaultMode, version: number): void {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (session && version >= session.defaultAccessModeVersion) {
      session.defaultAccessMode = mode;
      session.defaultAccessModeVersion = version;
    }
  }

  upsertTask(task: Task): void {
    const current = this.tasks.get(task.id);
    // 提交应答可能在任务终态事件之后到达，输入元数据仍可补齐，终态不可回滚。
    if (current && ((current.endedAt && !task.endedAt) || (current.status !== "queued" && task.status === "queued"))) {
      task = { ...task, ...current, input: task.input || current.input, inputPurpose: task.inputPurpose };
    }
    this.tasks.set(task.id, task);
    this.sessionViews.get(task.sessionId)?.flow.task(task);
  }

  addPendingInput(task: Task): void {
    this.openSession(task.sessionId).flow.task(task);
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
    return this.tasksFor(sessionId).filter((t) => t.status === "queued" && !t.reportParked);
  }

  /** 本会话发起的工作委托（issue 11；按登记顺序）。 */
  worksForSession(sessionId: string): WorkDelegation[] {
    return this.workDelegations
      .filter((w) => w.parentSessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  /** 普通工作区入口排除的内部会话（逻辑角色绑定 + SubAgent 内部工作会话）。 */
  excludedPickerSessionIds(): Set<string> {
    return new Set([...this.roleSessionIds, ...this.subAgentSessionIds]);
  }

  /** 本会话的工作委托汇总文本；没有委托时返回 null（不展示任何内容）。 */
  worksSummaryForSession(sessionId: string): string | null {
    const works = this.worksForSession(sessionId);
    if (!works.length) return null;
    const parts = works.map((work) => {
      if (work.canceledAt) return `${work.id.slice(0, 12)}…（已取消，${work.canceledBy}${work.cancelReason ? `，${work.cancelReason}` : ""}）`;
      const agent = this.subAgents.find((a) => a.id === work.subAgentId);
      const agentText = agent ? subAgentStateLabel(agent) : "未知";
      const latest = [...this.tasks.values()]
        .filter((t) => t.workId === work.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .at(-1);
      // issue 16：写入目标在快照到齐后展示；worktree 标分支与本地副本，非 Git 标直接写入
      const target = work.writeTarget;
      const targetText =
        target?.kind === "worktree" ? ` · worktree 分支 ${target.branch}` : target?.kind === "direct" ? " · 直接写入" : "";
      return `${work.id.slice(0, 12)}…（${agentText}${latest ? ` · 最近任务${formatTaskStatus(latest.status)}` : ""}${targetText}）`;
    });
    return `工作委托 ${parts.join("；")}`;
  }

  pendingApprovals(): ConfirmationRequestView[] {
    return this.confirmations.filter((c) => {
      const task = this.tasks.get(c.taskId);
      return c.status === "pending" && !!task && !TERMINAL_TASK_STATUSES.includes(task.status) && c.permissionVersion === task.permissionVersion;
    });
  }

  projectName(projectId: string): string {
    return this.projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  private noteForTask(taskId: string, text: string, at?: string): void {
    const task = this.tasks.get(taskId);
    this.note(task?.sessionId ?? null, text, at);
  }

  /**
   * 追加一条提示。
   *
   * at 必须传事件自身的 createdAt（由 noteForTask 透传），不能在这里取
   * 本地时间：提示与同一事件产生的任务结束标记要按时间排序，两个时钟
   * （服务器事件时间 vs 客户端本地时间）不一致时顺序会翻转。
   * 只有没有对应事件的本地提示（如提交失败）才回退到当前时间。
   */
  note(sessionId: string | null, text: string, at?: string): void {
    const note = { key: `note-${++this.noteCounter}`, text, at: at ?? new Date().toISOString() };
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
    view.flow.note(note.key, note.text, note.at);
  }
}

/** 访问模式显示名（/mode 列表、状态栏、模式提示共用）。 */
export function accessModeLabel(mode: SessionDefaultMode): string {
  switch (mode) {
    case "plan":
      return "☷ Plan";
    case "full_access":
      return "⏵⏵ Full access";
    case "auto-review":
      return "⏵⏵ Auto review";
    default:
      return "⏸ Ask for approval";
  }
}

export function formatAccessMode(mode: SessionDefaultMode, pending: AccessMode | null): string {
  const base = accessModeLabel(mode);
  return pending ? `${base}（待切换：${accessModeLabel(pending)}）` : base;
}

/** SubAgent 状态显示名（issue 11 展示；状态本身以快照为准；issue 12 已关闭优先）。 */
export function subAgentStateLabel(agent: Pick<SubAgent, "state" | "closedAt">): string {
  if (agent.closedAt) return "已关闭";
  switch (agent.state) {
    case "idle":
      return "空闲";
    case "running":
      return "运行中";
    case "unverified":
      return "待核实";
  }
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

/**
 * 会话标题的组织归属（issue 07 步骤 4）：ruukoto-code 按展示归属给出工作区标注
 * 与「配置与资料来源」项目（仅 mapped 时）；ruukoto 产品与其他场景用原身份。
 * 标题拼接（app.ts）与测试断言共用同一结论。
 */
export function sessionTitleAttribution(
  session: Session,
  projects: Project[],
  devProduct: boolean,
): { workspace: boolean; projectId: string; sourceProjectId: string | null } {
  if (!devProduct) return { workspace: false, projectId: session.projectId, sourceProjectId: null };
  const attribution = sessionDisplayAttribution(session, projects);
  return {
    workspace: attribution.kind !== "legacy",
    projectId: attribution.projectId,
    sourceProjectId: attribution.kind === "mapped" ? session.projectId : null,
  };
}
