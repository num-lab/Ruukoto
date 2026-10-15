import type { DesktopResult } from "../shared/bridge.ts";
import type { PendingOp } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";
import { serializeFailure } from "./controller.ts";
import type { OpParams, TuiOp } from "@ruukoto/control/ops.ts";

export const DESKTOP_OPS = ["list_session_summaries", "open_workspace", "create_session", "read_history", "read_history_entry", "list_tasks", "get_task", "read_task_events", "list_models", "set_session_model", "set_session_mode", "get_session", "interrupt", "cancel", "resume_queue", "submit", "continue"] as const satisfies readonly TuiOp[];
export type DesktopOp = typeof DESKTOP_OPS[number];
export type PersonalConfigOp = "desktop_personal_config_read" | "desktop_personal_config_save";

export async function ipcResult<T>(action: () => T | Promise<T>): Promise<DesktopResult<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: serializeFailure(error) }; }
}

export async function handleRequest(target: unknown, op: unknown, params: unknown, reconnect: () => Promise<void>, request: (op: DesktopOp, params: OpParams<DesktopOp>) => Promise<unknown>, local?: (op: PendingOp, params: Record<string, unknown>) => unknown, personalConfig?: (op: PersonalConfigOp, params: Record<string, unknown>) => unknown): Promise<DesktopResult<unknown>> {
  return ipcResult(async () => {
    if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    if (target === "personal" && (op === "desktop_personal_config_read" || op === "desktop_personal_config_save")) {
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "连接配置必须是对象。");
      if (!personalConfig) throw new DesktopError("target_unavailable", "Personal 配置入口不可用。");
      return personalConfig(op, params as Record<string, unknown>);
    }
    if (target === "personal" && op !== "reconnect") throw new DesktopError("op_not_allowed", "Personal 界面尚未开放此操作。");
    if (typeof op !== "string" || (op !== "reconnect" && op !== "desktop_pending_read" && op !== "desktop_pending_clear" && !DESKTOP_OPS.some(value => value === op))) throw new DesktopError("op_not_allowed", "此操作未向桌面客户端开放。");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "操作参数必须是对象。");
    if (op === "reconnect") {
      if (Object.keys(params).length !== 0) throw new DesktopError("invalid_params", "重新连接不接受参数。");
      return reconnect();
    }
    if (op === "desktop_pending_read" || op === "desktop_pending_clear") {
      if (!local) throw new DesktopError("connection_unavailable", "请等待连接恢复后再处理原输入。");
      return local(op, params as Record<string, unknown>);
    }
    // IPC 是不可信输入；各 op 的字段与权限继续由控制面校验。
    return request(op as DesktopOp, params as OpParams<DesktopOp>);
  });
}
