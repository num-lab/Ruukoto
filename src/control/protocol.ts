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
 */

import { PROTOCOL_VERSION, type Artifact, type ConfirmationRequest, type PersistentEvent, type Project, type Session, type Task } from "../core/types.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;

export const CONTROL_PROTOCOL_VERSION = PROTOCOL_VERSION;

export interface ConnectSnapshot {
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  confirmations: ConfirmationRequest[];
  artifacts: Artifact[];
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
