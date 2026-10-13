/**
 * TUI 用到的控制面 op：名字、参数与返回形状只在这里定义（架构工单 07）。
 *
 * 返回形状取服务端对应 Runtime 方法的返回类型（server.ts 直接返回它们）；
 * 服务端另包一层的照写。服务端派发、CLI 与配置中心仍按字符串，不经本表。
 */

import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { SessionDefaultMode, GrantedPath, ModelSelection } from "@ruukoto/core/types.ts";
import type { WorkflowControl } from "@ruukoto/core/workflow.ts";

/** Runtime 方法的返回类型（去掉 Promise）。 */
type R<M extends keyof Runtime> = Runtime[M] extends (...args: any[]) => infer T ? Awaited<T> : never;

type Slice = { offset?: number; length?: number };
type None = Record<string, never>;
type Submit = {
  session_id: string;
  request_id: string;
  input: string;
  model_selection: ModelSelection;
  access_mode?: SessionDefaultMode;
  granted_paths?: GrantedPath[];
};

export interface TuiOps {
  workflow_definitions: { params: { offset?: number; limit?: number }; result: Awaited<ReturnType<Runtime["workflowLibrary"]["list"]>> };
  workflow_definition: { params: { name?: string; definition_id?: string; version_offset?: number } & Slice; result: R<"getWorkflowDefinition"> };
  workflow_save: { params: { name: string; script: string; expected_digest: string | null; request_id: string }; result: R<"saveWorkflowDefinition"> };
  workflow_saved: { params: { request_id: string }; result: R<"findWorkflowSave"> };
  workflow_start: { params: { session_id: string; request_id: string; name?: string; script?: string; input: unknown; max_attempts?: number; duration_ms?: number }; result: R<"startWorkflowOwner"> };
  workflow_find: { params: { session_id: string; request_id: string }; result: R<"findWorkflow"> };
  workflow_list: { params: { session_id?: string; offset?: number; limit?: number }; result: R<"listWorkflows"> };
  workflow_get: { params: { run_id: string; step_offset?: number }; result: R<"getWorkflowDetail"> };
  workflow_step: { params: { run_id: string; step_key: string } & Slice; result: R<"getWorkflowStep"> };
  workflow_logs: { params: { run_id: string } & Slice; result: R<"getWorkflowLogs"> };
  workflow_control: { params: { run_id: string; expected_version: number; request_id: string; control: WorkflowControl }; result: R<"controlWorkflow"> };
  workflow_question: { params: { run_id: string; step_key: string } & Slice; result: R<"getWorkflowQuestion"> };
  workflow_answer: { params: { run_id: string; step_key: string; question_version: number; run_version: number; request_id: string; answer: unknown };
    result: { runId: string; stepKey: string; status: string; version: number; runVersion: number } };
  get_task: { params: { task_id: string }; result: NonNullable<R<"getTaskDetail">> };
  find_task: { params: { session_id: string; request_id: string }; result: R<"findTaskByRequest"> };
  list_tasks: { params: { session_id: string; before?: string; limit?: number }; result: R<"listTasks"> };
  read_task_events: { params: { task_id: string; after_seq?: number; limit?: number }; result: R<"readTaskEvents"> };
  read_history: {
    params: { session_id: string; before?: string; limit?: number; entry_text_cap?: number; page_text_budget?: number };
    result: R<"readHistory">;
  };
  read_tool_result: { params: { session_id: string; entry_id: string; length?: number }; result: R<"readToolResult"> };
  read_history_entry: { params: { session_id: string; entry_id: string } & Slice; result: R<"readHistoryEntry"> };
  get_tool_op_params: { params: { tool_op_id: string } & Slice; result: R<"getToolOpParams"> };
  get_confirmation_params: { params: { confirmation_id: string } & Slice; result: R<"getConfirmationParams"> };
  read_artifact: { params: { task_id: string; artifact_id: string; session_id?: string } & Slice; result: R<"queryArtifact"> };
  get_session_todos: { params: { session_id: string }; result: R<"getSessionTodos"> };
  branch_session: { params: { session_id: string; name?: string; request_id: string }; result: R<"branchSession"> };
  find_branch_session: { params: { request_id: string }; result: R<"findBranchSession"> };
  compact_session: { params: { session_id: string; request_id: string; prompt?: string }; result: R<"compactSession"> };
  get_session_compaction: { params: { session_id: string; request_id?: string }; result: R<"getSessionCompaction"> };
  interrupt_session_compaction: { params: { session_id: string; request_id: string }; result: R<"interruptSessionCompaction"> };
  get_session_usage: { params: { session_id: string }; result: R<"getSessionUsage"> };
  get_session: { params: { session_id: string }; result: R<"getSession"> };
  /** project_id 按原身份查询；workspace_id 按组织归属查询（issue 07）；两参互斥。 */
  list_session_summaries: { params: { project_id?: string; workspace_id?: string }; result: R<"listSessionSummaries"> };
  list_models: { params: { provider?: string; offset?: number; limit?: number }; result: R<"listModels"> };
  set_session_model: {
    params: { session_id: string; expected_version: number; model_selection: ModelSelection };
    result: R<"setSessionModel">;
  };
  set_session_mode: {
    params: { session_id: string; mode: SessionDefaultMode; expected_version: number };
    result: R<"setSessionDefaultMode">;
  };
  create_project: { params: { name: string; request_id?: string }; result: R<"createProject"> };
  create_session: {
    params: { project_id?: string; project_name?: string; cwd: string; confirm_tools?: string[]; request_id?: string };
    result: R<"createSession">;
  };
  /** 打开工作区（agent-direction issue 05）：按真实目录身份复用/创建工作区并新建会话。 */
  open_workspace: { params: { cwd: string; project_id?: string; request_id?: string }; result: R<"openWorkspace"> };
  submit: { params: Submit; result: R<"submit"> };
  continue: { params: Submit & { task_id: string }; result: R<"continueTask"> };
  interrupt: { params: { task_id: string }; result: { accepted: true } };
  cancel: { params: { task_id: string }; result: { accepted: true } };
  resume_queue: { params: { session_id: string; model_selection?: ModelSelection }; result: R<"resumeQueue"> };
  respond_confirmation: {
    params: { confirmation_id: string; decision: "approve" | "reject"; permission_version?: number };
    result: R<"respondConfirmation">;
  };
  list_selection_records: {
    params: { task_id?: string; session_id?: string; limit?: number };
    result: { records: R<"listSelectionRecords"> };
  };
  get_context_breakdown: { params: { session_id: string; record_id: string }; result: R<"getContextBreakdown"> };
  list_prompt_requests: {
    params: { session_id: string; limit?: number; cursor?: { createdAt: string; id: string } };
    result: R<"listPromptRequests">;
  };
  read_prompt_snapshot: { params: { record_id: string; session_id: string } & Slice; result: R<"readPromptSnapshot"> };
  search_history: {
    params: { query: string; project_id?: string; session_id?: string; task_id?: string; role?: string; limit?: number };
    result: R<"searchHistory">;
  };
  list_skills: { params: None; result: R<"listSkills"> };
  list_memories: { params: { project_id?: string; personal?: boolean }; result: { memories: R<"listMemories"> } };
  get_memory: { params: { memory_id: string }; result: R<"getMemoryDetail"> };
  revoke_memory: { params: { memory_id: string; expected_version: number; reason?: string }; result: R<"ownerRevokeMemory"> };
  restore_memory: { params: { memory_id: string; from_version: number; reason?: string }; result: R<"ownerRestoreMemory"> };
  qq_status: { params: None; result: R<"qqStatus"> };
  qq_set_enabled: { params: { enabled: boolean; expected_version?: number }; result: R<"qqSetEnabled"> };
  qq_inbox_list: { params: { group_id?: string; limit?: number }; result: { entries: R<"qqListInbox"> } };
  qq_outbox_list: { params: { group_id?: string; limit?: number }; result: { entries: R<"qqListOutbox"> } };
}

export type TuiOp = keyof TuiOps;
export type OpParams<K extends TuiOp> = TuiOps[K]["params"];
export type OpResult<K extends TuiOp> = TuiOps[K]["result"];
