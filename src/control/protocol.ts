/**
 * 控制面协议：Unix socket + 换行分帧 JSON。
 *
 * - 请求 {v, id, op, params}；应答 {v, id, ok, result|error}；
 * - 事件推送 {v, push:"event", event}，event.seq 单调递增，客户端按 seq 去重；
 * - 帧大小上限 MAX_FRAME_BYTES，超限断开；
 * - connect 返回快照 + (since, seq] 补发，随后无缝转入实时推送。
 *
 * 权限说明（ADR 0003）：数据目录 0700、socket 0600 只能做到同 UID 可达，
 * 无法区分拥有者终端与完全访问命令。issue 02 仅开放可信客户端与模拟工具；
 * 客户端授权凭据与身份隔离由 issue 03 完成并验证，不以 Unix socket 宣称
 * 满足权限保证。
 */

import type { ConfirmationRequest, PersistentEvent, Project, Session, Task } from "../core/types.ts";

export const MAX_FRAME_BYTES = 1024 * 1024;

export interface ConnectSnapshot {
  projects: Project[];
  sessions: Session[];
  tasks: Task[];
  confirmations: ConfirmationRequest[];
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
