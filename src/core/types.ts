/**
 * 领域类型：项目、会话、任务、确认请求、工具操作、持久事件。
 *
 * 术语沿用根目录 CONTEXT.md：会话一次执行一个任务；任务可中断、可排队；
 * 确认请求绑定具体操作。状态机不含排列组合：中断原因、取消意图与外部效果
 * 是否确定分别记录在任务字段中。
 */

import { randomBytes } from "node:crypto";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const PROTOCOL_VERSION = 5;

export interface ModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * 任务访问模式（ADR 0003）。
 * - confirm：请求确认模式。在已授权范围内自主执行（Linux 容器边界内），
 *   越界文件操作与外部网络以结构化审批请求逐次授权。
 * - full_access：完全访问模式。拥有者显式选择后，任务在容器外使用专用执行
 *   账户已有权限，不逐次确认。不额外赋权，也不提供执行账户内部的文件隔离。
 */
export type AccessMode = "confirm" | "full_access";

/** 已授权工作区外的具体路径权限（拥有者在可信入口为任务显式配置）。 */
export interface GrantedPath {
  path: string;
  access: "read" | "read_write";
  /** 用途说明（审批与快照展示）。 */
  purpose: string;
}

export type TaskStatus =
  | "queued"
  | "running"
  | "awaiting_confirmation"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = ["queued", "running", "awaiting_confirmation"];

/** 任务的执行结束状态（终态，不允许再转换）。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["completed", "failed", "canceled", "interrupted"];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export interface Project {
  id: string;
  name: string;
  /**
   * 项目指令文件（工作区相对路径，拥有者显式配置；issue 05 §3）。
   * 任务开始时经受限路径读取并钉版本；空数组 = 无项目指令。
   */
  instructionFiles: string[];
  createdAt: string;
}

export type SessionQueueState = "active" | "paused";

export interface Session {
  id: string;
  projectId: string;
  /** 绑定的工作目录（创建时规范化）。 */
  cwd: string;
  /** 目录身份：realpath 规范化路径。 */
  cwdReal: string;
  cwdDev: number;
  cwdIno: number;
  /** pi 会话 id（稳定，绑定 JSONL 历史文件）。 */
  piSessionId: string;
  /** JSONL 历史文件路径；新会话首次落盘前可能不存在。 */
  sessionFile: string | null;
  /** 需要拥有者确认的工具名列表（issue 03 接入真实权限判定）。 */
  confirmTools: string[];
  modelSelection: ModelSelection | null;
  modelSelectionVersion: number;
  queueState: SessionQueueState;
  queuePauseReason: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  sessionId: string;
  /** 客户端保存的幂等键，唯一范围为会话。 */
  requestId: string;
  /** 任务输入原文；送入 SDK 前是唯一副本，写入历史后关联对应条目。 */
  input: string;
  modelSelection: ModelSelection | null;
  /** 原始提交的不可变摘要；旧任务无法还原时为 null。 */
  submissionDigest: string | null;
  status: TaskStatus;
  /** 任务访问模式；默认请求确认。只有已认证拥有者能选择完全访问。 */
  accessMode: AccessMode;
  /** 提交时会话权限版本快照；切换/授权变化递增，旧审批消费时核对。 */
  permissionVersion: number;
  /** 拥有者为本任务显式授予的工作区外路径（如 worktree 的 Git 元数据）。 */
  grantedPaths: GrantedPath[];
  /** 模式切换已被请求、待在工具边界应用（应用前执行仍用旧模式）。 */
  pendingAccessMode: AccessMode | null;
  /** 中断原因（interrupted 时有值）。 */
  interruptReason: string | null;
  /** 显式取消意图（与中断原因分开记录）。 */
  cancelRequested: boolean;
  /** 存在执行意图但结果缺失、外部效果不确定的工具操作数。 */
  effectUnknown: boolean;
  /** 失败时的错误说明。 */
  errorMessage: string | null;
  /** 本任务引用的会话历史条目 id（user 输入与 assistant 输出）。 */
  historyEntryIds: string[];
  /** 本任务继续自哪个被中断的任务。 */
  resumesTaskId: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type ConfirmationStatus = "pending" | "approved" | "rejected" | "stale";

/** 审批展示的权限范围（结构化、可验证；凭据只出现名称与用途，不含原值）。 */
export type ApprovalScope =
  | { kind: "tool"; workspaceOnly: boolean }
  | {
      kind: "file_operation";
      path: string;
      access: "read" | "read_write";
      /** 待写内容的原文件版本指纹（写入前置条件）；读操作为 null。 */
      originalSha256: string | null;
      /** 待写入内容的字节数与指纹（展示内容本身，不含凭据）。 */
      contentSha256: string | null;
      contentBytes: number | null;
    }
  | {
      kind: "http_request";
      method: string;
      url: string;
      /** 引用的凭据绑定名称与用途；不含凭据值。 */
      credentials: Array<{ name: string; purpose: string }>;
    }
  | {
      kind: "github_publish";
      /** 发布操作 id（github_publish_ops.id）。 */
      publishOpId: string;
      draftId: string;
      draftVersion: number;
      /** 仓库身份（apiHost/owner/repo + 核实的 repository ID）。 */
      apiHost: string;
      owner: string;
      repo: string;
      repoId: number | null;
      /** 发布类型与目标（PR 评审评论 / issue 评论）。 */
      publishKind: "pr_review_comment" | "issue_comment";
      target: Record<string, unknown>;
      /** 待发布正文字节数与指纹（正文经 get_confirmation 分段读取）。 */
      bodySha256: string;
      bodyBytes: number;
      /** 分析修订（head/base SHA、run/attempt 等，按发布类型取用）。 */
      revisions: Record<string, unknown>;
    };

export interface ConfirmationRequest {
  id: string;
  taskId: string;
  sessionId: string;
  /** 宿主分配的工具操作 id（不信任模型生成的 toolCallId）。 */
  toolOpId: string;
  toolName: string;
  params: Record<string, unknown>;
  /** 结构化权限范围；审批展示与消费校验依据。 */
  scope: ApprovalScope;
  /** 请求时的工作目录身份（会话 cwd 的 dev/ino；展示与核对用）。 */
  cwdDev: number;
  cwdIno: number;
  /** 请求时的任务权限版本；版本不匹配的批准不得消费。 */
  permissionVersion: number;
  status: ConfirmationStatus;
  createdAt: string;
  respondedAt: string | null;
  /** 批准后实际启动执行的时间；null 表示已批准但尚未开始（崩溃窗口）。 */
  consumedAt: string | null;
}

export interface ToolOp {
  /** 宿主分配的操作 id（与模型生成的 SDK 调用 id 分开存储）。 */
  id: string;
  taskId: string;
  toolName: string;
  /** 模型生成的调用 id，仅供关联展示；不作为操作身份。 */
  sdkCallId: string | null;
  params: Record<string, unknown>;
  /** 执行意图已记录（创建即 true）。 */
  intentRecordedAt: string;
  /** 已知结果摘要；null 表示结果缺失。 */
  resultSummary: string | null;
  isError: boolean | null;
  /** 结果缺失且工具可能已产生外部效果。 */
  effectUnknown: boolean;
  recordedResultAt: string | null;
}

/** 工具正文产物：捕获于上游截断之前，供限长模型视图之外的按需查询。 */
export interface Artifact {
  id: string;
  taskId: string;
  sessionId: string;
  /** 来源描述（工具名 + 对象，如 bash stdout / 文件路径）。 */
  name: string;
  /** 已捕获字节数（部分捕获时小于全量）。 */
  byteCount: number;
  /** complete：结果已回收后定稿；partial：中断/写入失败等场景的已捕获部分。 */
  status: "complete" | "partial";
  createdAt: string;
}

/** 持久事件载荷（JSON 序列化后存 events.payload）。 */
export type PersistentEventBody =
  | { type: "project.created"; projectId: string; name: string }
  | { type: "session.created"; sessionId: string; projectId: string; cwd: string; modelSelection: ModelSelection | null; modelSelectionVersion: number }
  | { type: "session.model_selection_changed"; sessionId: string; modelSelection: ModelSelection; modelSelectionVersion: number }
  | { type: "tasks.model_selection_recorded"; sessionId: string; taskIds: string[]; modelSelection: ModelSelection }
  | { type: "task.queued"; taskId: string; sessionId: string; requestId: string; accessMode: AccessMode; modelSelection: ModelSelection }
  | { type: "task.started"; taskId: string; sessionId: string }
  | { type: "task.awaiting_confirmation"; taskId: string; confirmationId: string; toolOpId: string; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean; scope: ApprovalScope; permissionVersion?: number }
  | { type: "task.confirmation_resolved"; taskId: string; confirmationId: string; decision: "approved" | "rejected" }
  | { type: "task.approval_consumed"; taskId: string; confirmationId: string; toolOpId: string; toolName: string }
  | { type: "task.mode_switch_requested"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode }
  | { type: "task.mode_switched"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode; permissionVersion: number }
  | { type: "task.mode_switch_failed"; taskId: string; sessionId: string; to: AccessMode; reason: string }
  /**
   * 运行中输出的有界预览（v3）：text 为截至当时的累计文本尾部
   * （FRAGMENT_TEXT_CAP），totalBytes/truncated 标明完整规模；messageId 是
   * 后台分配的消息标识，同一消息的片段替换同一预览，最终条目经
   * task.output_entry.messageId 关联后取代预览。
   */
  | { type: "task.output_fragment"; taskId: string; sessionId: string; messageId: string; text: string; totalBytes: number; truncated: boolean; partial: true }
  | { type: "task.output_entry"; taskId: string; sessionId: string; entryId: string; sessionFile: string; role: string; messageId: string | null }
  /**
   * 工具/审批事件（线上载荷）：params 可能被替换为有界预览
   * （paramsTruncated=true，paramsBytes 为完整序列化字节数）；完整参数经
   * get_confirmation / get_tool_op 按 ID 分段读取。持久化的事件正文保持完整。
   */
  | { type: "task.tool_intent"; taskId: string; toolOpId: string; sdkCallId: string | null; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean }
  | { type: "task.tool_result"; taskId: string; toolOpId: string; summary: string; isError: boolean; artifactIds: string[] }
  | { type: "task.tool_effect_unknown"; taskId: string; toolOpId: string; toolName: string }
  | { type: "task.tool_process_unreaped"; taskId: string; sessionId: string; reason: string }
  | { type: "task.completed"; taskId: string; sessionId: string }
  | { type: "task.failed"; taskId: string; sessionId: string; errorMessage: string }
  | { type: "task.canceled"; taskId: string; sessionId: string }
  | { type: "task.interrupted"; taskId: string; sessionId: string; reason: string; cancelRequested: boolean; effectUnknown: boolean }
  | { type: "task.continued"; taskId: string; sessionId: string; resumesTaskId: string }
  | { type: "session.queue_paused"; sessionId: string; reason: string }
  | { type: "session.queue_resumed"; sessionId: string }
  | { type: "occupancy.stale"; sessionId: string; taskId: string; cwdReal: string }
  | { type: "session.history_unreadable"; sessionId: string; sessionFile: string; error: string }
  | { type: "data_grant.created"; grantId: string; fromProjectId: string; toProjectId: string; category: DataCategory }
  | { type: "data_grant.revoked"; grantId: string; fromProjectId: string; toProjectId: string; category: DataCategory }
  | { type: "memory.saved"; memoryId: string; projectId: string | null; version: number; author: "agent" | "owner"; taskId: string | null }
  | { type: "memory.revoked"; memoryId: string; projectId: string | null; version: number; author: "agent" | "owner"; taskId: string | null }
  | { type: "memory.restored"; memoryId: string; projectId: string | null; fromVersion: number; newVersion: number; author: "agent" | "owner"; taskId: string | null }
  | { type: "github.binding_changed"; bindingId: string; projectId: string; apiHost: string; owner: string; repo: string; configVersion: number; action: "upsert" | "removed" }
  | { type: "github.draft_saved"; draftId: string; version: number; taskId: string; sessionId: string; kind: string; bodySha256: string; bodyBytes: number }
  | { type: "github.draft_stale"; draftId: string; version: number; reason: string }
  | { type: "github.publish_requested"; publishOpId: string; draftId: string; draftVersion: number; taskId: string; sessionId: string }
  | { type: "github.publish_settled"; publishOpId: string; draftId: string; status: "sent" | "failed" | "effect_unknown" | "canceled"; remoteUrl: string | null; errorMessage: string | null }
  | { type: "backend.started"; dataDir: string; executionBackend: string }
  | { type: "backend.stopping"; reason: string }
  | { type: "backend.stopped"; reason: string }
  | { type: "backend.recovered"; interruptedTaskIds: string[]; pausedSessionIds: string[] };

export interface PersistentEvent {
  seq: number;
  taskId: string | null;
  sessionId: string | null;
  body: PersistentEventBody;
  createdAt: string;
}

/** 资料类别（跨项目授权与范围判定的粒度）。 */
export type DataCategory = "history" | "artifact" | "memory";

export const DATA_CATEGORIES: readonly DataCategory[] = ["history", "artifact", "memory"];

/**
 * 跨项目资料授权（issue 05 §1）：拥有者在可信入口显式设置来源项目、目标
 * 项目与资料类别；模型只能请求读取已有范围，不能自行创建授权。
 */
export interface DataGrant {
  id: string;
  /** 资料所属项目（来源）。 */
  fromProjectId: string;
  /** 允许读取的项目（目标）。 */
  toProjectId: string;
  category: DataCategory;
  /** 用途说明（展示与审计）。 */
  purpose: string;
  createdAt: string;
  revokedAt: string | null;
}

/** 长期记忆类别（CONTEXT.md：个人偏好、项目约定、已确认决策、经验）。 */
export type MemoryCategory = "preference" | "convention" | "decision" | "experience";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ["preference", "convention", "decision", "experience"];

/** 记忆来源引用（必须存在且可访问；owner_note 由控制面记录可信操作）。 */
export type MemorySourceRef =
  | { kind: "history_entry"; sessionId: string; entryId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "owner_note"; note: string };

/** 长期记忆当前状态（生效版本在 memory_versions 中按版本号查询）。 */
export interface Memory {
  id: string;
  /** 适用项目；personal 共享范围为 null。 */
  projectId: string | null;
  /** personal = 拥有者明确设为个人共享；project = 仅本项目。 */
  scope: "project" | "personal";
  category: MemoryCategory;
  /** 当前版本号（1 起）。 */
  currentVersion: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/** 记忆的一次修订（追加式，不删除旧版本）。 */
export interface MemoryVersion {
  memoryId: string;
  version: number;
  content: string;
  sourceRefs: MemorySourceRef[];
  /** agent = Agent 工具写入（不能伪称拥有者确认）；owner = 控制面操作。 */
  author: "agent" | "owner";
  /** 关联的宿主操作 id（Agent 写入时；结果查询可据此核实是否已提交）。 */
  toolOpId: string | null;
  /** 写入时的任务（Agent 作者）。 */
  taskId: string | null;
  reason: string;
  createdAt: string;
}

/** 一次模型调用的上下文选择记录（调试与 Jev 对比用）。 */
export interface SelectionRecord {
  id: string;
  taskId: string;
  sessionId: string;
  /** 任务内第几次模型调用（1 起）。 */
  callIndex: number;
  strategy: string;
  configVersion: number;
  model: string;
  /** 输入消息总数（当前分支）。 */
  totalMessages: number;
  /** 选入消息的宿主临时序号（与 inputMessageIds 对应）。 */
  includedIndices: number[];
  /** 排除消息的序号与原因。 */
  excluded: Array<{ index: number; reason: string }>;
  /** 选入的记忆（id@version）与未选入原因。 */
  includedMemories: Array<{ memoryId: string; version: number }>;
  excludedMemories: Array<{ memoryId: string; version: number; reason: string }>;
  /** 项目指令来源版本（内容哈希 + 捕获产物 id；空串 = 本项目无配置指令）。 */
  instructionVersion: string;
  /** 模型视图中被有界替换的工具结果（原消息序号 + 原/视图字符数；原文不动）。 */
  cappedToolResults: Array<{ index: number; originalChars: number; viewChars: number }>;
  /** 估算明细（分类 token 估计）。 */
  estimates: Record<string, number>;
  /** 总预算与估算合计。 */
  budget: number;
  estimatedTotal: number;
  /** 发送后补记的实际 provider usage（可空：失败/中断时无）。 */
  usage: { input: number; output: number } | null;
  createdAt: string;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * 任务边界标记条目（pi JSONL 中的 custom 条目 customType；不进模型上下文）。
 * 历史索引据此推导任务的字节范围（按任务过滤搜索）。
 */
export const TASK_START_MARKER = "ruukoto_task_start";
export const TASK_END_MARKER = "ruukoto_task_end";
