/**
 * Version 50: authenticated Unix-socket control for the sole ruukoto product.
 * Authentication binds the activated layout and reserved instance before any operation.
 * Snapshot installation and event subscription share one sequence boundary; reconnect
 * restores observation without replaying writes. Desktop browser requests retain their
 * private bidirectional request/response and browser-event transport.
 */

import {
  PROTOCOL_VERSION,
  type Artifact,
  type PersistentEvent,
  type Project,
  type Session,
  type SubAgent,
  type WorkDelegation,
} from "@ruukoto/core/types.ts";
import type { ProductType } from "@ruukoto/core/product.ts";
import type { ConfirmationRequestView, OutputPreview, TaskView } from "@ruukoto/core/views.ts";
import type { BackgroundProcessView } from "@ruukoto/core/background-processes.ts";
import type { OwnerQuestionView } from "@ruukoto/core/owner-questions.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const CONTROL_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface ConnectSnapshot {
  product: ProductType;
  layout: "ruukoto-single-v1";
  projects: Project[];
  sessions: Session[];
  /** 活动任务 + 每会话有界的近期结束任务；更早的经 list_tasks 分页。 */
  tasks: TaskView[];
  /** 未决审批（参数有界预览；完整参数经 get_confirmation_params 分段读取）。 */
  confirmations: ConfirmationRequestView[];
  artifacts: Artifact[];
  /** 活动/中断任务的最新输出预览（重连重建；缺失片段如实为空）。 */
  previews: Record<string, OutputPreview>;
  /** 数据实例稳定标识：待确认请求绑定它；新数据库分配新标识。 */
  instanceId: string;
  /** 执行后端与说明（local 无隔离必须显式展示）。 */
  execution: { backend: string; note: string };
  /** 后台启动默认模型；会话选择和任务实际配置分别随会话、任务返回。 */
  defaultModel: { provider: string; id: string; name: string; thinkingLevel: string };
  /** 实例级 Web Search 开关（全实例共用；旧后台缺省视为启用）。 */
  webSearch?: { state: "enabled" | "disabled"; version: number };
  /** SubAgent 的内部工作会话（普通工作区列表排除；旧后台缺省）。 */
  subAgentSessionIds?: string[];
  /** 工作委托（issue 11；只读视图，状态/历史/任务事件与产物沿用既有接口）。 */
  workDelegations?: WorkDelegation[];
  /** 动态 SubAgent 身份（含运行/空闲/待核实状态）。 */
  subAgents?: SubAgent[];
  ownerQuestions?: OwnerQuestionView[];
  codeScheduleRuns?: import("@ruukoto/core/code-scheduler.ts").CodeScheduleRun[];
  backgroundProcesses?: BackgroundProcessView[];
  /** 引导路由（coding-message-control）：全部状态随快照下发，投影与重排共用同一事实。 */
  taskGuidance?: import("@ruukoto/core/types.ts").TaskGuidance[];
  /** 侧聊持久绑定（coding-side-chat）：重连后据此恢复侧聊身份；侧聊会话不在 sessions 内。 */
  sideChats?: Array<{ parentSessionId: string; sideSessionId: string }>;
  /** Pending recall requests and open edit windows; absent on older backends. */
  messageRecalls?: import("@ruukoto/core/types.ts").PublicMessageRecall[];
}

/** 单任务持久事件分页；nextAfter 非空时继续读，最终消息正文以历史接口为准。 */
export interface TaskEventsPage {
  events: PersistentEvent[];
  nextAfter: number | null;
}

export interface ConnectResult {
  /** 快照截止序号；实时推送自此之后开始，无缺口。 */
  seq: number;
  /** (since, seq] 的补发事件；fresh connect（无 since）为空。 */
  replay: PersistentEvent[];
  snapshot: ConnectSnapshot;
}

export type ControlRequest = {
  v: number;
  id: string;
  op: string;
  params?: Record<string, unknown>;
};

export type ControlResponse = {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type ControlPush = {
  v: number;
  push: "event";
  event: PersistentEvent;
};

/** 服务端→已登记客户端的窄请求（v47）：客户端以 ControlResponse 形状帧应答。 */
export type ControlCall = {
  v: number;
  push: "request";
  id: string;
  op: string;
  params?: Record<string, unknown>;
};

/** 页面事实上报（Go browser.Manager 的 Event 同形）；非持久事件，不进重放。 */
export type DesktopBrowserEvent = {
  session: string;
  kind: "gate" | "nav" | "title" | "gone" | "closed";
  generation: number;
  owned?: boolean;
  ownerHeld?: boolean;
  returnGeneration?: number;
  source?: "owner" | "host";
  url?: string;
  title?: string;
};

/** 截图/快照的有界分块（每块 ≤256KiB 原始字节）；command_id 绑定在途请求。 */
export type DesktopBrowserChunk = {
  command_id: string;
  index: number;
  total: number;
  total_bytes: number;
  sha256: string;
  data: string;
};

export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}
