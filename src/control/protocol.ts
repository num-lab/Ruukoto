/**
 * 控制面协议：Unix socket + 换行分帧 JSON。
 *
 * - 请求 {v, id, op, params}；应答 {v, id, ok, result|error}；
 * - 事件推送 {v, push:"event", event}，event.seq 单调递增，客户端按 seq 去重；
 * - 帧大小上限 MAX_FRAME_BYTES，超限断开；
 * - connect 返回快照 + (since, seq] 补发，随后无缝转入实时推送。
 *
 * 拥有者认证（v2，ADR 0003）：连接建立后首个操作必须是 auth（携带拥有者
 * 令牌）；认证成功前不返回快照、不执行任何请求。令牌只经控制面受控目录的
 * 令牌文件或拥有者自己的环境变量传递，不出现在命令行、工具环境或日志中。
 *
 * v3（issue 04）：快照有界化（活动任务 + 每会话近期结束任务，更早的经
 * list_tasks 分页）；握手返回数据实例标识与执行后端说明；活动/中断任务
 * 携带输出预览；确认请求与工具操作经有界参数视图传输（完整参数按 ID
 * 分段读取）；新增历史读取与 request_id 核实接口。版本不匹配时服务端
 * 以 bad_request 明确拒绝，客户端应提示升级而非静默重试。
 */

import {
  PROTOCOL_VERSION,
  type Artifact,
  type PersistentEvent,
  type Project,
  type Session,
  type Task,
} from "../core/types.ts";
import type { ConfirmationRequestView, OutputPreview } from "../core/views.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const CONTROL_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface ConnectSnapshot {
  projects: Project[];
  sessions: Session[];
  /** 活动任务 + 每会话有界的近期结束任务；更早的经 list_tasks 分页。 */
  tasks: Task[];
  /** 未决审批（参数有界预览；完整参数经 get_confirmation_params 分段读取）。 */
  confirmations: ConfirmationRequestView[];
  artifacts: Artifact[];
  /** 活动/中断任务的最新输出预览（重连重建；缺失片段如实为空）。 */
  previews: Record<string, OutputPreview>;
  /** 数据实例稳定标识：待确认请求绑定它；新数据库分配新标识。 */
  instanceId: string;
  /** 执行后端与说明（local 无隔离必须显式展示）。 */
  execution: { backend: string; note: string };
  /** 生效的模型来源、模型名与思考强度（只读展示）。 */
  model: { provider: string; id: string; name: string; thinkingLevel: string };
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

export function encodeFrame(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}
