/**
 * TUI 用到的控制面 op：名字、参数与返回形状只在这里定义（架构工单 07）。
 *
 * 返回类型取服务端调用的 Runtime 或 RuntimeModels 方法（server.ts 直接返回它们）；
 * 服务端另包一层的照写。服务端派发、CLI 与配置中心仍按字符串，不经本表。
 */

import type { AttachmentMetadata, AttachmentUpload } from "@ruukoto/core/attachments.ts";
import type { RuntimeModels } from "@ruukoto/runtime/models.ts";
import type { Runtime } from "@ruukoto/runtime/runtime.ts";
import type { SessionDefaultMode, GrantedPath, ModelSelection } from "@ruukoto/core/types.ts";
import type { WorkflowControl } from "@ruukoto/core/workflow.ts";
import type { ToolResultField } from "@ruukoto/core/history.ts";
import type { CodeScheduleConfig } from "@ruukoto/core/code-scheduler.ts";

/** Runtime 方法的返回类型（去掉 Promise）。 */
type R<M extends keyof Runtime> = Runtime[M] extends (...args: any[]) => infer T ? Awaited<T> : never;
type MR<M extends keyof RuntimeModels> = RuntimeModels[M] extends (...args: never[]) => infer T ? Awaited<T> : never;
type SkillId = Parameters<Runtime["getSkill"]>[0];

export type HistorySearchWireCursor = { session_id: string; byte_offset: number; phase?: "index" | "scan"; read_offset?: number; source?: { file_dev: number; file_ino: number; min_size: number }; query_key?: string };

type Slice = { offset?: number; length?: number };
type None = Record<string, never>;
type Submit = {
  session_id: string;
  request_id: string;
  input: string;
  model_selection: ModelSelection;
  attachments?: AttachmentMetadata[];
  access_mode?: SessionDefaultMode;
  granted_paths?: GrantedPath[];
};

export interface TuiOps {
  code_schedules: { params: { offset?: number; limit?: number; scope?: "current" | "history" }; result: R<"listCodeSchedules"> };
  code_schedule: { params: { plan_id: string; run_offset?: number }; result: R<"getCodeSchedule"> };
  code_schedule_save: { params: { request_id: string; plan_id?: string; expected_version?: number; config: CodeScheduleConfig }; result: R<"saveCodeSchedule"> };
  code_schedule_control: { params: { request_id: string; plan_id: string; expected_version: number; control: "pause" | "resume" | "cancel"; acknowledge_run_id?: string; expected_run_version?: number }; result: R<"controlCodeSchedule"> };
  code_schedule_receipt: { params: { request_id: string }; result: R<"findCodeScheduleReceipt"> };
  background_processes: { params: { session_id: string; offset?: number }; result: R<"listBackgroundProcesses"> };
  background_process_output: { params: { session_id: string; process_id: string; stream: "stdout" | "stderr"; offset?: number }; result: R<"backgroundProcessOutput"> };
  background_process_stop: { params: { session_id: string; process_id: string }; result: R<"stopBackgroundProcess"> };
  session_background_end: { params: { session_id: string; request_id: string }; result: R<"endSessionBackground"> };
  owner_questions: { params: { session_id: string; offset?: number; limit?: number }; result: R<"listOwnerQuestions"> };
  owner_question_answer: { params: { session_id: string; question_id: string; question_version: number; request_id: string;
    answers: import("@ruukoto/core/owner-questions.ts").OwnerAnswer[]; model_selection: ModelSelection; access_mode?: SessionDefaultMode; granted_paths?: GrantedPath[] }; result: R<"answerOwnerQuestion"> };
  owner_question_cancel: { params: { session_id: string; question_id: string; question_version: number; request_id: string }; result: R<"cancelOwnerQuestion"> };
  owner_question_receipt: { params: { session_id: string; request_id: string; operation: "owner_question_answer" | "owner_question_cancel" }; result: R<"findOwnerQuestionReceipt"> };
  work_list: { params: { session_id?: string }; result: R<"workList"> };
  work_get: { params: { work_id: string }; result: R<"workGet"> };
  workflow_definitions: { params: { offset?: number; limit?: number }; result: Awaited<ReturnType<Runtime["workflowLibrary"]["list"]>> };
  workflow_definition: { params: { name?: string; definition_id?: string; version_offset?: number } & Slice; result: R<"getWorkflowDefinition"> };
  workflow_save: { params: { name: string; script: string; expected_digest: string | null; request_id: string }; result: R<"saveWorkflowDefinition"> };
  workflow_saved: { params: { request_id: string }; result: R<"findWorkflowSave"> };
  workflow_start: { params: { session_id: string; request_id: string; name?: string; script?: string; title?: string; description?: string; input: unknown; max_attempts?: number; duration_ms?: number }; result: R<"startWorkflowOwner"> };
  workflow_find: { params: { session_id: string; request_id: string }; result: R<"findWorkflow"> };
  workflow_list: { params: { session_id?: string; offset?: number; limit?: number; scope?: "current" | "history" }; result: R<"listWorkflows"> };
  workflow_get: { params: { run_id: string; step_offset?: number }; result: R<"getWorkflowDetail"> };
  workflow_step: { params: { run_id: string; step_key: string } & Slice; result: R<"getWorkflowStep"> };
  workflow_logs: { params: { run_id: string } & Slice; result: R<"getWorkflowLogs"> };
  workflow_control: { params: { run_id: string; expected_version: number; request_id: string; control: WorkflowControl }; result: R<"controlWorkflow"> };
  workflow_receipt: { params: { run_id: string; request_id: string; operation: "workflow_answer" | "workflow_control" }; result: R<"findWorkflowReceipt"> };
  workflow_question: { params: { run_id: string; step_key: string } & Slice; result: R<"getWorkflowQuestion"> };
  workflow_answer: { params: { run_id: string; step_key: string; question_version: number; run_version: number; request_id: string; answer: unknown };
    result: { runId: string; stepKey: string; status: string; version: number; runVersion: number } };
  get_task: { params: { task_id: string }; result: NonNullable<R<"getTaskDetail">> };
  find_task: { params: { session_id: string; request_id: string }; result: R<"findTaskByRequest"> };
  list_tasks: { params: { session_id: string; before?: string; limit?: number }; result: R<"listTasks"> };
  read_task_events: { params: { task_id: string; after_seq?: number; limit?: number }; result: R<"readTaskEvents"> };
  read_history: {
    params: { session_id: string; before?: string; after?: string; around?: string; source?: string; limit?: number; entry_text_cap?: number; page_text_budget?: number };
    result: R<"readHistory">;
  };
  read_tool_result: { params: { session_id: string; entry_id: string; length?: number; field?: ToolResultField; offset?: number }; result: R<"readToolResult"> };
  read_history_entry: { params: { session_id: string; entry_id: string; source?: string } & Slice; result: R<"readHistoryEntry"> };
  get_tool_op_mcp: { params: { tool_op_id: string } & Slice; result: R<"getToolOpMcp"> };
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
  list_session_summaries: { params: { project_id?: string; workspace_id?: string; scope?: "workspace_chats" }; result: R<"listSessionSummaries"> };
  list_models: { params: { provider?: string; offset?: number; limit?: number }; result: MR<"list"> };
  get_model_config: { params: None; result: MR<"getConfig"> };
  save_model_catalog: { params: { providers: Record<string, unknown>; expected_revision: string }; result: MR<"saveCatalog"> };
  set_model_api_key: { params: { provider: string; api_key: string; expected_revision: string }; result: MR<"setApiKey"> };
  remove_model_api_key: { params: { provider: string; expected_revision: string }; result: MR<"removeApiKey"> };
  remove_model_provider: { params: { provider: string; expected_revision: string }; result: MR<"removeProvider"> };
  set_default_model: { params: { provider: string; model_id: string; thinking_level: string; expected_revision: string }; result: MR<"setDefault"> };
  set_summary_model: { params: { provider: string | null; model_id: string | null; expected_revision: string }; result: MR<"setSummary"> };
  test_model_connection: { params: { provider: string; model_id: string }; result: MR<"testConnection"> };
  mcp_list: { params: Record<string, never>; result: { services: R<"mcpListServices"> } };
  mcp_configure: { params: { service_id?: string; name: string; endpoint?: string; cua?: Parameters<Runtime["mcpConfigure"]>[0]["cua"]; credential?: string | null; tool_allowlist: Array<string | { name: string; effect: "read" | "write" | "unknown" }>; enabled?: boolean; expected_version?: number }; result: R<"mcpConfigure"> };
  mcp_cua_status: { params: Record<string, never>; result: R<"mcpCuaStatus"> };
  mcp_cua_targets: { params: Record<string, never>; result: R<"mcpCuaTargets"> };
  mcp_cua_stop: { params: { service_id?: string }; result: R<"mcpCuaStop"> };
  mcp_cua_begin_recovery: { params: Record<string, never>; result: R<"mcpCuaBeginRecovery"> };
  mcp_cua_observe: { params: Record<string, never>; result: R<"mcpCuaObserve"> };
  mcp_cua_accept: { params: { observation_id: string }; result: R<"mcpCuaAccept"> };
  mcp_set_enabled: { params: { service_id: string; enabled: boolean; expected_version?: number }; result: R<"mcpSetEnabled"> };
  mcp_remove: { params: { service_id: string; expected_version?: number }; result: { removed: R<"mcpRemoveService"> } };
  mcp_check: { params: { service_id: string }; result: R<"mcpCheckService"> };
  mcp_save_credential: { params: { name: string; endpoint: string; secret: string }; result: R<"mcpSaveCredential"> };
  mcp_remove_credential: { params: { name: string }; result: R<"mcpRemoveCredential"> };
  web_search_save_credential: { params: { secret: string }; result: R<"webSearchSaveCredential"> };
  web_search_remove_credential: { params: Record<string, never>; result: R<"webSearchRemoveCredential"> };
  set_web_search: { params: { enabled: boolean; expected_version?: number }; result: R<"setWebSearch"> };
  list_credentials: { params: { purpose?: string; endpoint?: string }; result: R<"listCredentialBindings"> };
  remove_credential: { params: { name: string }; result: { removed: R<"removeCredentialBinding"> } };
  set_session_model: {
    params: { session_id: string; expected_version: number; model_selection: ModelSelection };
    result: R<"setSessionModel">;
  };
  set_session_archived: { params: { session_id: string; archived: boolean }; result: R<"setSessionArchived"> };
  set_session_mode: {
    params: { session_id: string; mode: SessionDefaultMode; expected_version: number };
    result: R<"setSessionDefaultMode">;
  };
  create_project: { params: { name: string; request_id?: string }; result: R<"createProject"> };
  create_session: {
    params: { project_id?: string; project_name?: string; cwd: string; confirm_tools?: string[]; request_id?: string; mode?: SessionDefaultMode; model_selection?: ModelSelection };
    result: R<"createSession">;
  };
  /** 打开工作区（agent-direction issue 05）：按真实目录身份复用/创建工作区并新建会话。 */
  open_workspace: { params: { cwd: string; project_id?: string; request_id?: string; mode?: SessionDefaultMode; model_selection?: ModelSelection }; result: R<"openWorkspace"> };
  list_workspace_files: { params: { workspace_id: string; path?: string; cursor?: string }; result: R<"listWorkspaceFiles"> };
  read_workspace_file: { params: { workspace_id: string; path: string; offset?: number; length?: number; version?: string }; result: R<"readWorkspaceFile"> };
  read_workspace_git: { params: { workspace_id: string; cursor?: string }; result: R<"readWorkspaceGit"> };
  put_attachment: { params: AttachmentUpload; result: R<"putAttachment"> };
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
    params: { query: string; project_id?: string; session_id?: string; task_id?: string; role?: string; limit?: number; scope?: "workspace_chats"; cursor?: HistorySearchWireCursor | null; scan_limit?: number; context_chars?: number; since?: string; until?: string };
    result: R<"searchHistory">;
  };
  list_skills: { params: None; result: R<"listSkills"> };
  skills_list: { params: { offset?: number; limit?: number }; result: R<"listManagedSkills"> };
  skill_get: { params: { skill_id: SkillId }; result: R<"getSkill"> };
  skill_import_preview: { params: { source_dir: string }; result: R<"previewSkillImport"> };
  skill_import: { params: { skill_id: SkillId; source_dir: string; content_revision: string; expected_revision: string }; result: R<"importSkill"> };
  skill_set_enabled: { params: { skill_id: SkillId; enabled: boolean; expected_revision: string }; result: R<"setSkillEnabled"> };
  skill_remove: { params: { skill_id: SkillId; expected_revision: string }; result: R<"removeSkill"> };
  list_subagent_roles: { params: None; result: R<"listSubAgentRoles"> };
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
