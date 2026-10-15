import type { DesktopResult } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";
import { serializeFailure } from "./controller.ts";
import type { OpParams, TuiOp } from "@ruukoto/control/ops.ts";

export const DESKTOP_OPS = ["list_session_summaries", "open_workspace", "create_session", "read_history", "read_history_entry", "list_tasks", "get_task", "read_task_events"] as const satisfies readonly TuiOp[];
export type DesktopOp = typeof DESKTOP_OPS[number];

export async function ipcResult<T>(action: () => T | Promise<T>): Promise<DesktopResult<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: serializeFailure(error) }; }
}

export async function handleRequest(target: unknown, op: unknown, params: unknown, reconnect: () => Promise<void>, request: (op: DesktopOp, params: OpParams<DesktopOp>) => Promise<unknown>): Promise<DesktopResult<unknown>> {
  return ipcResult(async () => {
    if (target !== "code") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    if (typeof op !== "string" || (op !== "reconnect" && !DESKTOP_OPS.some(value => value === op))) throw new DesktopError("op_not_allowed", "此操作未向桌面客户端开放。");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "操作参数必须是对象。");
    if (op === "reconnect") {
      if (Object.keys(params).length !== 0) throw new DesktopError("invalid_params", "重新连接不接受参数。");
      return reconnect();
    }
    // IPC 是不可信输入；各 op 的字段与权限继续由控制面校验。
    return request(op as DesktopOp, params as OpParams<DesktopOp>);
  });
}
