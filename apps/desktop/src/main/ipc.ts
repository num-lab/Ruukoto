import type { DesktopResult } from "../shared/bridge.ts";
import type { PendingOp } from "../shared/bridge.ts";
import { DesktopError } from "./environment.ts";
import { serializeFailure } from "./controller.ts";
import type { OpParams, TuiOp } from "@ruukoto/control/ops.ts";

export const CODE_MODEL_OPS = ["get_model_config", "save_model_catalog", "set_model_api_key", "remove_model_api_key", "remove_model_provider", "set_default_model", "set_summary_model", "test_model_connection"] as const satisfies readonly TuiOp[];
export const CODE_MCP_OPS = ["mcp_list", "mcp_configure", "mcp_set_enabled", "mcp_remove", "mcp_check", "mcp_cua_targets", "mcp_cua_status", "mcp_cua_stop", "mcp_cua_begin_recovery", "mcp_cua_observe", "mcp_cua_accept", "get_tool_op_mcp", "list_credentials", "mcp_save_credential", "mcp_remove_credential"] as const satisfies readonly TuiOp[];
export const CODE_SKILL_OPS = ["skills_list", "skill_get", "skill_set_enabled", "skill_remove"] as const satisfies readonly TuiOp[];
export const DESKTOP_OPS = [...CODE_MODEL_OPS, ...CODE_MCP_OPS, ...CODE_SKILL_OPS, "search_history", "list_session_summaries", "open_workspace", "create_session", "read_history", "read_history_entry", "list_tasks", "get_task", "read_task_events", "work_list", "work_get", "read_tool_result", "read_artifact", "get_tool_op_params", "list_models", "set_session_model", "set_session_mode", "set_session_archived", "get_session", "interrupt", "cancel", "resume_queue", "get_confirmation_params", "respond_confirmation", "submit", "continue", "background_processes", "background_process_output", "background_process_stop", "session_background_end", "owner_questions", "owner_question_answer", "owner_question_cancel", "owner_question_receipt", "list_prompt_requests", "get_context_breakdown", "list_workspace_files", "read_workspace_file", "read_workspace_git"] as const satisfies readonly TuiOp[];
export type DesktopOp = typeof DESKTOP_OPS[number];
export const PERSONAL_READ_OPS = ["read_history", "read_history_entry", "list_tasks", "get_task", "read_task_events", "work_list", "work_get", "read_tool_result", "get_tool_op_params", "list_models", "get_session", "get_confirmation_params", "list_prompt_requests", "get_context_breakdown"] as const satisfies readonly DesktopOp[];
export const PERSONAL_OPS = [...PERSONAL_READ_OPS, "set_session_model", "set_session_mode", "set_session_archived", "interrupt", "cancel", "resume_queue", "respond_confirmation", "submit", "continue"] as const satisfies readonly DesktopOp[];
export type PersonalConfigOp = "desktop_personal_config_read" | "desktop_personal_config_save";
export const TERMINAL_OPS = ["desktop_terminal_open", "desktop_terminal_input", "desktop_terminal_resize", "desktop_terminal_kill"] as const;
type LocalOp = PendingOp | typeof TERMINAL_OPS[number];

export async function ipcResult<T>(action: () => T | Promise<T>): Promise<DesktopResult<T>> {
  try { return { ok: true, value: await action() }; }
  catch (error) { return { ok: false, error: serializeFailure(error) }; }
}

export async function handleRequest(target: unknown, op: unknown, params: unknown, reconnect: () => Promise<void>, request: (op: DesktopOp, params: OpParams<DesktopOp>) => Promise<unknown>, local?: (op: LocalOp, params: Record<string, unknown>) => unknown, personalConfig?: (op: PersonalConfigOp, params: Record<string, unknown>) => unknown): Promise<DesktopResult<unknown>> {
  return ipcResult(async () => {
    if (target !== "code" && target !== "personal") throw new DesktopError("target_unavailable", "此连接目标尚未启用。");
    if (target === "personal" && (op === "desktop_personal_config_read" || op === "desktop_personal_config_save")) {
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "连接配置必须是对象。");
      if (!personalConfig) throw new DesktopError("target_unavailable", "Personal 配置入口不可用。");
      return personalConfig(op, params as Record<string, unknown>);
    }
    if (target === "personal" && op !== "reconnect" && op !== "desktop_pending_read" && op !== "desktop_pending_clear" && !PERSONAL_OPS.some(value => value === op)) throw new DesktopError("op_not_allowed", "此操作未向 Personal 开放。");
    if (typeof op !== "string" || (op !== "reconnect" && op !== "desktop_pending_read" && op !== "desktop_pending_clear" && !TERMINAL_OPS.some(value => value === op) && !DESKTOP_OPS.some(value => value === op))) throw new DesktopError("op_not_allowed", "此操作未向桌面客户端开放。");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw new DesktopError("invalid_params", "操作参数必须是对象。");
    if (target === "personal" && (op === "set_session_mode" && "mode" in params && params.mode === "plan" || (op === "submit" || op === "continue") && "access_mode" in params && params.access_mode === "plan")) throw new DesktopError("invalid_params", "Plan 只能在普通开发会话中使用。");
    if (op === "reconnect") {
      if (Object.keys(params).length !== 0) throw new DesktopError("invalid_params", "重新连接不接受参数。");
      return reconnect();
    }
    if (op === "desktop_pending_read" || op === "desktop_pending_clear") {
      if (!local) throw new DesktopError("connection_unavailable", "请等待连接恢复后再处理原输入。");
      return local(op, params as Record<string, unknown>);
    }
    if (TERMINAL_OPS.some(value => value === op)) {
      if (!local) throw new DesktopError("terminal_closed", "终端宿主不可用，请重新打开应用。");
      return local(op as typeof TERMINAL_OPS[number], params as Record<string, unknown>);
    }
    // IPC 是不可信输入；各 op 的字段与权限继续由控制面校验。
    return request(op as DesktopOp, params as OpParams<DesktopOp>);
  });
}
