/**
 * 领域类型：项目、会话、任务、确认请求、工具操作、持久事件。
 *
 * 术语沿用根目录 CONTEXT.md：会话一次执行一个任务；任务可中断、可排队；
 * 确认请求绑定具体操作。状态机不含排列组合：中断原因、取消意图与外部效果
 * 是否确定分别记录在任务字段中。
 */

import { randomBytes } from "node:crypto";

export const PROTOCOL_VERSION = 1;

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
  status: TaskStatus;
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

export interface ConfirmationRequest {
  id: string;
  taskId: string;
  sessionId: string;
  /** 工具操作 id（toolCallId）。 */
  toolOpId: string;
  toolName: string;
  params: Record<string, unknown>;
  status: ConfirmationStatus;
  createdAt: string;
  respondedAt: string | null;
}

export interface ToolOp {
  /** 工具调用 id。 */
  id: string;
  taskId: string;
  toolName: string;
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

/** 持久事件载荷（JSON 序列化后存 events.payload）。 */
export type PersistentEventBody =
  | { type: "project.created"; projectId: string; name: string }
  | { type: "session.created"; sessionId: string; projectId: string; cwd: string }
  | { type: "task.queued"; taskId: string; sessionId: string; requestId: string }
  | { type: "task.started"; taskId: string; sessionId: string }
  | { type: "task.awaiting_confirmation"; taskId: string; confirmationId: string; toolOpId: string; toolName: string; params: Record<string, unknown> }
  | { type: "task.confirmation_resolved"; taskId: string; confirmationId: string; decision: "approved" | "rejected" }
  | { type: "task.output_fragment"; taskId: string; sessionId: string; text: string; partial: true }
  | { type: "task.output_entry"; taskId: string; sessionId: string; entryId: string; sessionFile: string; role: string }
  | { type: "task.tool_intent"; taskId: string; toolOpId: string; toolName: string; params: Record<string, unknown> }
  | { type: "task.tool_result"; taskId: string; toolOpId: string; summary: string; isError: boolean }
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
  | { type: "backend.started"; dataDir: string }
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

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
