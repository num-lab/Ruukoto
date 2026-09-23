/**
 * 领域类型：项目、会话、任务、确认请求、工具操作、持久事件。
 *
 * 术语沿用根目录 CONTEXT.md：会话一次执行一个任务；任务可中断、可排队；
 * 确认请求绑定具体操作。状态机不含排列组合：中断原因、取消意图与外部效果
 * 是否确定分别记录在任务字段中。
 */

import { randomBytes } from "node:crypto";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const PROTOCOL_VERSION = 8;

export interface ModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * 任务访问模式（ADR 0003；auto-review 见 ADR 0005）。
 * - confirm：请求确认模式。在已授权范围内自主执行（Linux 容器边界内），
 *   越界文件操作与外部网络以结构化审批请求逐次授权。
 * - full_access：完全访问模式。拥有者显式选择后，任务在容器外使用专用执行
 *   账户已有权限，不逐次确认。不额外赋权，也不提供执行账户内部的文件隔离。
 * - auto-review：自动审查模式。与 confirm 同一受限执行环境；越界的外部文件
 *   读取与无凭据 HTTP 读取先经独立审查调用自动审批（approve/reject/ask_owner），
 *   无法确认或审查失败一律转拥有者；不扩大授权范围，不升级为完全访问。
 */
export type AccessMode = "confirm" | "full_access" | "auto-review";

/**
 * 会话默认访问模式（issue 12）：新建任务在未显式指定模式时沿用。
 * 取值与 AccessMode 相同。
 */
export type SessionDefaultMode = AccessMode;

/** 会话默认模式的取值列表（显示与入参校验共用）。 */
export const SESSION_DEFAULT_MODES: readonly SessionDefaultMode[] = ["confirm", "full_access", "auto-review"];

/** 访问模式入参校验（CLI/控制面/运行时共用的类型守卫，消除字面量重复）。 */
export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === "string" && (SESSION_DEFAULT_MODES as readonly string[]).includes(value);
}

/** 已授权工作区外的具体路径权限（拥有者在可信入口为任务显式配置）。 */
export interface GrantedPath {
  path: string;
  access: "read" | "read_write";
  /** 用途说明（审批与快照展示）。 */
  purpose: string;
}

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
  /**
   * 项目指令文件（工作区相对路径，拥有者显式配置；issue 05 §3）。
   * 任务开始时经受限路径读取并钉版本；空数组 = 无项目指令。
   */
  instructionFiles: string[];
  /**
   * Web Search 开关（issue 20）：默认 enabled；拥有者可按项目显式禁用。
   * 任务开始固定工具清单；禁用立即阻止后续调用，启用从下一任务生效。
   */
  webSearch: "enabled" | "disabled";
  createdAt: string;
}

export type SessionQueueState = "active" | "paused";

/**
 * 会话入口类别（issue 07）：
 * - dev：拥有者可信 CLI/TUI 创建的开发会话（默认）；
 * - qq_group：QQ 群聊入口会话（NapCat/OneBot），由宿主按“登录账号+群”创建；
 *   空工具集合、资料范围宿主约束（排除开发历史/个人共享记忆/项目指令/跨项目
 *   授权）、专用空工作目录、排队过期与发送控制由 QQ 适配器执行。
 */
export type SessionKind = "dev" | "qq_group";

/**
 * 逻辑角色（issue 01 日常助手编排）：main 负责日常对话与编排，coding 处理
 * 仓库/代码，chat 处理群聊。角色绑定独立的 Project/Session/工作目录/模型/
 * 工具白名单；配置只由宿主（编排器）设置，输入正文、项目指令与模型结果
 * 不能修改。
 */
export type AgentRoleId = "main" | "coding" | "chat";

export const AGENT_ROLE_IDS: readonly AgentRoleId[] = ["main", "coding", "chat"];

/**
 * 角色工具白名单的粒度：按工具注册来源划分类别（编码工具/宿主资料与记忆/
 * Web Search/MCP/应用数据）。装配、发送前最终检查与调用门三层共用同一份名单。
 * app_data 仅 main 角色包含（issue 02：应用数据空间，仅宿主可信绑定）。
 */
export type ToolCategory = "coding" | "host_data" | "web_search" | "mcp" | "app_data";

/** 角色配置（宿主管理；agent_roles 表）。modelSelection 为 null 时用后台默认模型。 */
export interface AgentRole {
  id: AgentRoleId;
  projectId: string;
  sessionId: string;
  workDir: string;
  modelSelection: ModelSelection | null;
  tools: ToolCategory[];
  createdAt: string;
}

/** 入站事件处理状态：registered（已登记未建任务）→ queued → done / failed。 */
export type InboundEventStatus = "registered" | "queued" | "done" | "failed";

/**
 * 持久入站事件（issue 01）：外部消息/定时器/子任务结果进入编排器的统一
 * 入口。先持久化再建任务；(source, externalId) 唯一即幂等键，重复登记不
 * 重复建任务。正文在登记时截断封顶。
 */
export interface InboundEvent {
  id: string;
  /** 来源入口（如 telegram / qq / scheduler / github / internal）。 */
  source: string;
  /** 来源内的外部 id（与 source 组成幂等键）。 */
  externalId: string;
  /** 触发者标识（不含凭据；null = 未知/系统）。 */
  actor: string | null;
  targetRole: AgentRoleId;
  body: string;
  /** 正文引用的产物 id 列表（引用传递，不复制内容）。 */
  artifactRefs: string[];
  receivedAt: string;
  status: InboundEventStatus;
  /** 由本事件创建的任务（queued 时回填）。 */
  taskId: string | null;
}

export interface Session {
  id: string;
  projectId: string;
  /** 入口类别（默认 dev；不可经任务/工具参数变更）。 */
  kind: SessionKind;
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
  modelSelection: ModelSelection | null;
  modelSelectionVersion: number;
  /** 会话默认访问模式；新建任务未显式指定时固定为提交瞬间的该值。 */
  defaultAccessMode: SessionDefaultMode;
  /** 默认模式版本号：条件更新（CAS）与冲突检测用。 */
  defaultAccessModeVersion: number;
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
  modelSelection: ModelSelection | null;
  /** 原始提交的不可变摘要；旧任务无法还原时为 null。 */
  submissionDigest: string | null;
  status: TaskStatus;
  /** 任务访问模式；默认请求确认。只有已认证拥有者能选择完全访问。 */
  accessMode: AccessMode;
  /** 提交时会话权限版本快照；切换/授权变化递增，旧审批消费时核对。 */
  permissionVersion: number;
  /** 拥有者为本任务显式授予的工作区外路径（如 worktree 的 Git 元数据）。 */
  grantedPaths: GrantedPath[];
  /** 模式切换已被请求、待在工具边界应用（应用前执行仍用旧模式）。 */
  pendingAccessMode: AccessMode | null;
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
  /** 执行该任务的逻辑角色（issue 01；null = 拥有者直接提交的任务）。 */
  agentId: AgentRoleId | null;
  /** 父任务 id（编排器委派的子任务；null = 无父任务）。 */
  parentTaskId: string | null;
  /** 来源入站事件 id（null = 非事件触发）。 */
  sourceEventId: string | null;
  /** 截止时间（ISO；超时由编排器取消；null = 无期限）。 */
  deadline: string | null;
  /** 结构化结果摘要（终态后由编排器记录，一次写入；null = 尚未记录）。 */
  resultSummary: string | null;
  /** 结果引用（JSON：完整结果的查询位置，如 {"sessionId","taskId"}）。 */
  resultRef: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export type ConfirmationStatus = "pending" | "approved" | "rejected" | "stale";

/** 审批展示的权限范围（结构化、可验证；凭据只出现名称与用途，不含原值）。 */
export type ApprovalScope =
  | { kind: "tool"; workspaceOnly: boolean }
  | {
      kind: "file_operation";
      path: string;
      access: "read" | "read_write";
      /** 待写内容的原文件版本指纹（写入前置条件）；读操作为 null。 */
      originalSha256: string | null;
      /** 待写入内容的字节数与指纹（展示内容本身，不含凭据）。 */
      contentSha256: string | null;
      contentBytes: number | null;
    }
  | {
      kind: "http_request";
      method: string;
      url: string;
      /** 引用的凭据绑定名称与用途；不含凭据值。 */
      credentials: Array<{ name: string; purpose: string }>;
    }
  | {
      /**
       * 普通 MCP 工具操作（issue 18）：有副作用或副作用不明的 MCP 工具统一
       * 审批范围。批准绑定任务、服务、工具、不可变参数、权限与配置版本；
       * 凭据只出现引用名，值不进入审批视图或事件。
       */
      kind: "mcp_tool";
      /** 服务 ID 与拥有者命名（展示用）。 */
      serviceId: string;
      serviceName: string;
      /** 服务端点（审批展示核对目标；不含 userinfo，凭据值不出现）。 */
      endpoint: string;
      /** 请求时的服务配置版本；消费前重读核对，变化即失效。 */
      configVersion: number;
      /** 远端工具名（暴露名见 ConfirmationRequest.toolName）。 */
      remoteName: string;
      /** 工具定义版本：任务钉版的名称/描述/schema/副作用类别摘要。 */
      toolSignature: string;
      /** 规范化参数的 sha256 摘要；完整参数见审批 params（同一份不可变快照）。 */
      paramsSha256: string;
      /** 凭据引用名（CredentialStore 绑定名；null = 无认证）。 */
      credential: string | null;
      /** 本地副作用类别（拥有者声明；远端注解不作依据）。 */
      operationCategory: "write" | "unknown";
    }
  | {
      /**
       * 应用数据破坏性变更（issue 02）：固定应用数据库身份、任务与操作 ID、
       * 表与操作类别、schema/revision、规范化参数摘要与受影响数量。行操作固定
       * 准确的行 ID 与行版本；schema 操作固定旧定义与新定义。批准仅消费一次，
       * 消费前重核 main 身份、任务状态、权限版本与应用数据版本。
       */
      kind: "app_data_change";
      /** 应用数据库实例身份（绑定 main.db，换库后旧批准不得消费）。 */
      appDbInstanceId: string;
      /** 发起任务与宿主操作（审批范围的固定锚点）。 */
      taskId: string;
      toolOpId: string;
      /** 目标表（跨表迁移时为 null，明细在 params）。 */
      table: string | null;
      /** 工具操作（define_table / migrate / insert / update / delete）。 */
      operation: string;
      /** 破坏性类别（展示与审计）：删表/删字段/删唯一索引/多行写/批量重写。 */
      change: "drop_table" | "drop_field" | "drop_unique_index" | "multi_row_write" | "rewrite_rows";
      /** 请求时的应用数据版本；消费前重读核对，变化即失效。 */
      schemaVersion: number;
      revision: number;
      /** 规范化参数的 sha256 摘要；完整参数见审批 params（不可变快照）。 */
      paramsSha256: string;
      /** 受影响数量（行数或迁移步数）。 */
      affected: number;
      /** 行操作固定的准确行 ID 与预期行版本。 */
      rowIds: number[];
      rowVersions: Record<string, number>;
      /** schema 操作的旧定义与新定义（删表/删字段只有旧定义）。 */
      definitionBefore: Record<string, unknown> | null;
      definitionAfter: Record<string, unknown> | null;
    }
  | {
      /**
       * 已退役（issue 17）：专用 GitHub 发布模块已删除，新任务不再产生此范围。
       * 仅为历史审批记录的只读展示保留（迁移已将未消费的旧审批失效）。
       */
      kind: "github_publish";
      /** 发布操作 id（github_publish_ops.id）。 */
      publishOpId: string;
      draftId: string;
      draftVersion: number;
      /** 仓库身份（apiHost/owner/repo + 核实的 repository ID）。 */
      apiHost: string;
      owner: string;
      repo: string;
      repoId: number | null;
      /** 发布类型与目标（PR 评审评论 / issue 评论）。 */
      publishKind: "pr_review_comment" | "issue_comment";
      target: Record<string, unknown>;
      /** 待发布正文字节数与指纹（正文经 get_confirmation 分段读取）。 */
      bodySha256: string;
      bodyBytes: number;
      /** 分析修订（head/base SHA、run/attempt 等，按发布类型取用）。 */
      revisions: Record<string, unknown>;
    };

export interface ConfirmationRequest {
  id: string;
  taskId: string;
  sessionId: string;
  /** 宿主分配的工具操作 id（不信任模型生成的 toolCallId）。 */
  toolOpId: string;
  toolName: string;
  params: Record<string, unknown>;
  /** 结构化权限范围；审批展示与消费校验依据。 */
  scope: ApprovalScope;
  /** 请求时的工作目录身份（会话 cwd 的 dev/ino；展示与核对用）。 */
  cwdDev: number;
  cwdIno: number;
  /** 请求时的任务权限版本；版本不匹配的批准不得消费。 */
  permissionVersion: number;
  status: ConfirmationStatus;
  createdAt: string;
  respondedAt: string | null;
  /** 批准后实际启动执行的时间；null 表示已批准但尚未开始（崩溃窗口）。 */
  consumedAt: string | null;
  /**
   * 自动审查状态（issue 15；null = 未经自动审查的历史/纯人工记录）：
   * in_progress 审查中 → done（自动批准/拒绝）| asked_owner（转人工）|
   * superseded（人工抢先或取消，迟到结果忽略）。
   */
  reviewStatus: "in_progress" | "done" | "asked_owner" | "superseded" | null;
  /** 审查结论（approve/reject/ask_owner）；与最终 status 分开，最终批准者看 decisionSource。 */
  reviewDecision: "approve" | "reject" | "ask_owner" | null;
  /** 审查理由（转人工时说明原因）。 */
  reviewReason: string | null;
  /** 实际执行审查的模型（provider/modelId）。 */
  reviewModel: string | null;
  /** 审查策略版本（随规则演进递增，供审计核对）。 */
  reviewPolicyVersion: string | null;
  /** 最终决定来源：owner = 拥有者；auto_review = 自动审查。 */
  decisionSource: "owner" | "auto_review" | null;
}

export interface ToolOp {
  /** 宿主分配的操作 id（与模型生成的 SDK 调用 id 分开存储）。 */
  id: string;
  taskId: string;
  toolName: string;
  /** 模型生成的调用 id，仅供关联展示；不作为操作身份。 */
  sdkCallId: string | null;
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

/** 工具正文产物：捕获于上游截断之前，供限长模型视图之外的按需查询。 */
export interface Artifact {
  id: string;
  taskId: string;
  sessionId: string;
  /** 来源描述（工具名 + 对象，如 bash stdout / 文件路径）。 */
  name: string;
  /** 已捕获字节数（部分捕获时小于全量）。 */
  byteCount: number;
  /** complete：结果已回收后定稿；partial：中断/写入失败等场景的已捕获部分。 */
  status: "complete" | "partial";
  createdAt: string;
}

/** 持久事件载荷（JSON 序列化后存 events.payload）。 */
export type PersistentEventBody =
  | { type: "project.created"; projectId: string; name: string }
  | { type: "session.created"; sessionId: string; projectId: string; kind: SessionKind; cwd: string; modelSelection: ModelSelection | null; modelSelectionVersion: number }
  | { type: "session.model_selection_changed"; sessionId: string; modelSelection: ModelSelection; modelSelectionVersion: number }
  | { type: "session.default_mode_changed"; sessionId: string; defaultAccessMode: SessionDefaultMode; defaultAccessModeVersion: number }
  | { type: "tasks.model_selection_recorded"; sessionId: string; taskIds: string[]; modelSelection: ModelSelection }
  | { type: "task.queued"; taskId: string; sessionId: string; requestId: string; accessMode: AccessMode; modelSelection: ModelSelection }
  | { type: "task.started"; taskId: string; sessionId: string }
  | { type: "task.awaiting_confirmation"; taskId: string; confirmationId: string; toolOpId: string; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean; scope: ApprovalScope; permissionVersion?: number; reviewStatus?: "in_progress" | null; reviewModel?: string | null; reviewPolicyVersion?: string | null }
  | { type: "task.confirmation_resolved"; taskId: string; confirmationId: string; decision: "approved" | "rejected"; source?: "owner" | "auto_review"; reason?: string }
  /** 自动审查转人工（issue 15）：审批仍 pending，等待拥有者决定。 */
  | { type: "task.confirmation_reviewed"; taskId: string; confirmationId: string; decision: "ask_owner"; reason: string }
  | { type: "task.approval_consumed"; taskId: string; confirmationId: string; toolOpId: string; toolName: string }
  | { type: "task.mode_switch_requested"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode }
  | { type: "task.mode_switched"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode; permissionVersion: number }
  | { type: "task.mode_switch_failed"; taskId: string; sessionId: string; to: AccessMode; reason: string }
  /**
   * 运行中输出的有界预览（v3）：text 为截至当时的累计文本尾部
   * （FRAGMENT_TEXT_CAP），totalBytes/truncated 标明完整规模；messageId 是
   * 后台分配的消息标识，同一消息的片段替换同一预览，最终条目经
   * task.output_entry.messageId 关联后取代预览。
   */
  | { type: "task.output_fragment"; taskId: string; sessionId: string; messageId: string; text: string; totalBytes: number; truncated: boolean; partial: true }
  | { type: "task.output_entry"; taskId: string; sessionId: string; entryId: string; sessionFile: string; role: string; messageId: string | null }
  /**
   * 工具/审批事件（线上载荷）：params 可能被替换为有界预览
   * （paramsTruncated=true，paramsBytes 为完整序列化字节数）；完整参数经
   * get_confirmation / get_tool_op 按 ID 分段读取。持久化的事件正文保持完整。
   */
  | { type: "task.tool_intent"; taskId: string; toolOpId: string; sdkCallId: string | null; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean }
  | { type: "task.tool_result"; taskId: string; toolOpId: string; summary: string; isError: boolean; artifactIds: string[] }
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
  | { type: "data_grant.created"; grantId: string; fromProjectId: string; toProjectId: string; category: DataCategory }
  | { type: "data_grant.revoked"; grantId: string; fromProjectId: string; toProjectId: string; category: DataCategory }
  | { type: "memory.saved"; memoryId: string; projectId: string | null; version: number; author: "agent" | "owner"; taskId: string | null }
  | { type: "memory.revoked"; memoryId: string; projectId: string | null; version: number; author: "agent" | "owner"; taskId: string | null }
  | { type: "memory.restored"; memoryId: string; projectId: string | null; fromVersion: number; newVersion: number; author: "agent" | "owner"; taskId: string | null }
  // github.* 事件类型已随专用模块退役（issue 17）：不再产生新事件，仅为
  // 历史事件重放/只读展示与退役迁移的终结事件保留。
  | { type: "github.binding_changed"; bindingId: string; projectId: string; apiHost: string; owner: string; repo: string; configVersion: number; action: "upsert" | "removed" }
  | { type: "github.draft_saved"; draftId: string; version: number; taskId: string; sessionId: string; kind: string; bodySha256: string; bodyBytes: number }
  | { type: "github.draft_stale"; draftId: string; version: number; reason: string }
  | { type: "github.publish_requested"; publishOpId: string; draftId: string; draftVersion: number; taskId: string; sessionId: string }
  | { type: "github.publish_settled"; publishOpId: string; draftId: string; status: "sent" | "failed" | "effect_unknown" | "canceled"; remoteUrl: string | null; errorMessage: string | null }
  | { type: "mcp.service_changed"; serviceId: string; projectId: string; name: string; endpoint: string; configVersion: number; action: "upsert" | "enabled" | "disabled" | "removed" }
  /** 任务开始时显式启用的服务初始化失败（连接/认证/超时等）：本任务缺少其工具能力。 */
  | { type: "mcp.service_unavailable"; serviceId: string; projectId: string; taskId: string; sessionId: string; name: string; endpoint: string; reason: string }
  /**
   * QQ 入口配置变化（issue 07）：连接参数/群允许列表/启停。不含 token
   * （凭据值只在 CredentialStore）；configVersion 随任何变化递增。
   */
  | { type: "qq.config_changed"; configVersion: number; action: "upsert" | "enabled" | "disabled" | "group_added" | "group_removed"; groupId?: string }
  /**
   * QQ 接收缺口（issue 07）：连接中断后重连成功时标记中断窗口——断线期间的
   * 群消息不假定平台会重投，缺失如实记录，不补抓、不补发。
   */
  | { type: "qq.receive_gap"; from: string; to: string }
  | { type: "backend.started"; dataDir: string; executionBackend: string }
  | { type: "backend.stopping"; reason: string }
  | { type: "backend.stopped"; reason: string }
  | { type: "backend.recovered"; interruptedTaskIds: string[]; pausedSessionIds: string[] }
  /** 入站事件已登记（issue 01；先持久化再建任务，重复登记不产生新事件）。 */
  | { type: "inbound.registered"; eventId: string; source: string; externalId: string; targetRole: AgentRoleId; actor: string | null }
  /** 入站事件已建任务并入队。 */
  | { type: "inbound.queued"; eventId: string; taskId: string; targetRole: AgentRoleId }
  /** 子任务完成（结果摘要与引用已记录在任务上）。 */
  | { type: "child_task.completed"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; summary: string; resultRef: string }
  | { type: "child_task.failed"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; errorMessage: string }
  /** 子任务超过截止时间被编排器取消。 */
  | { type: "child_task.timeout"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; deadline: string }
  /** 子任务结果未知（如后台重启中断）；不自动重放任何外部副作用。 */
  | { type: "child_task.result_unknown"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; reason: string }
  /**
   * 应用数据能力不可用（issue 02）：main.db 丢失、实例身份不符、损坏或存储
   * 格式过新/迁移失败。不自动重建、不覆盖既有实例绑定；工具保持关闭。
   */
  | { type: "app_data.unavailable"; reason: string }
  /**
   * 应用数据操作被拒绝（issue 02）：调用门/身份校验/参数校验/预算超限/超时。
   * 只记来源、操作类别与错误码，不复制无限长输入或整条个人数据。
   */
  | { type: "app_data.rejected"; taskId: string | null; sessionId: string | null; source: "tool_call_gate" | "identity" | "validation" | "budget" | "timeout"; toolName: string; code: string };

export interface PersistentEvent {
  seq: number;
  taskId: string | null;
  sessionId: string | null;
  body: PersistentEventBody;
  createdAt: string;
}

/** 资料类别（跨项目授权与范围判定的粒度）。 */
export type DataCategory = "history" | "artifact" | "memory";

export const DATA_CATEGORIES: readonly DataCategory[] = ["history", "artifact", "memory"];

/**
 * 跨项目资料授权（issue 05 §1）：拥有者在可信入口显式设置来源项目、目标
 * 项目与资料类别；模型只能请求读取已有范围，不能自行创建授权。
 */
export interface DataGrant {
  id: string;
  /** 资料所属项目（来源）。 */
  fromProjectId: string;
  /** 允许读取的项目（目标）。 */
  toProjectId: string;
  category: DataCategory;
  /** 用途说明（展示与审计）。 */
  purpose: string;
  createdAt: string;
  revokedAt: string | null;
}

/** 长期记忆类别（CONTEXT.md：个人偏好、项目约定、已确认决策、经验）。 */
export type MemoryCategory = "preference" | "convention" | "decision" | "experience";

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = ["preference", "convention", "decision", "experience"];

/** 记忆来源引用（必须存在且可访问；owner_note 由控制面记录可信操作）。 */
export type MemorySourceRef =
  | { kind: "history_entry"; sessionId: string; entryId: string }
  | { kind: "artifact"; artifactId: string }
  | { kind: "owner_note"; note: string };

/** 长期记忆当前状态（生效版本在 memory_versions 中按版本号查询）。 */
export interface Memory {
  id: string;
  /** 适用项目；personal 共享范围为 null。 */
  projectId: string | null;
  /** personal = 拥有者明确设为个人共享；project = 仅本项目。 */
  scope: "project" | "personal";
  category: MemoryCategory;
  /** 当前版本号（1 起）。 */
  currentVersion: number;
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

/** 记忆的一次修订（追加式，不删除旧版本）。 */
export interface MemoryVersion {
  memoryId: string;
  version: number;
  content: string;
  sourceRefs: MemorySourceRef[];
  /** agent = Agent 工具写入（不能伪称拥有者确认）；owner = 控制面操作。 */
  author: "agent" | "owner";
  /** 关联的宿主操作 id（Agent 写入时；结果查询可据此核实是否已提交）。 */
  toolOpId: string | null;
  /** 写入时的任务（Agent 作者）。 */
  taskId: string | null;
  reason: string;
  createdAt: string;
}

/** 请求当时的窗口与预留配置快照（issue 14；记录创建后配置变化不影响还原）。 */
export interface WindowSnapshot {
  contextWindow: number;
  /** 输出上限（思考已计入，不重复预留）。 */
  maxTokens: number;
  thinkingBudget: number;
  toolResultReserve: number;
  safetyMargin: number;
}

/** 一次模型调用的上下文选择记录（调试与 Jev 对比用）。 */
export interface SelectionRecord {
  id: string;
  taskId: string;
  sessionId: string;
  /** 任务内第几次模型调用（1 起）。 */
  callIndex: number;
  strategy: string;
  configVersion: number;
  model: string;
  /** 输入消息总数（当前分支）。 */
  totalMessages: number;
  /** 选入消息的宿主临时序号（与 inputMessageIds 对应）。 */
  includedIndices: number[];
  /** 排除消息的序号与原因。 */
  excluded: Array<{ index: number; reason: string }>;
  /** 选入的记忆（id@version）与未选入原因。 */
  includedMemories: Array<{ memoryId: string; version: number }>;
  excludedMemories: Array<{ memoryId: string; version: number; reason: string }>;
  /** 项目指令来源版本（内容哈希 + 捕获产物 id；空串 = 本项目无配置指令）。 */
  instructionVersion: string;
  /** 模型视图中被有界替换的工具结果（原消息序号 + 原/视图字符数；原文不动）。 */
  cappedToolResults: Array<{ index: number; originalChars: number; viewChars: number }>;
  /** 估算明细（分类 token 估计）。 */
  estimates: Record<string, number>;
  /** 总预算与估算合计。 */
  budget: number;
  estimatedTotal: number;
  /** 发送后补记的实际 provider usage（可空：失败/中断时无）。 */
  usage: { input: number; output: number } | null;
  /** 发送前捕获的不可变输入快照（产物 id；空 = 该次 prompt 正文未记录）。 */
  promptArtifactId: string | null;
  /** 窗口与预留快照（null = 旧记录无快照，无法计算总窗口占比）。 */
  windowSnapshot: WindowSnapshot | null;
  createdAt: string;
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/**
 * 时间表示统一为 UTC ISO 字符串（入库与比较的唯一形式）：ISO  UTC 字符串的
 * 字典序即时间序，超时巡检可按字符串比较。非法输入返回 null（调用方拒绝）。
 */
export function normalizeIsoInstant(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 任务边界标记条目（pi JSONL 中的 custom 条目 customType；不进模型上下文）。
 * 历史索引据此推导任务的字节范围（按任务过滤搜索）。
 */
export const TASK_START_MARKER = "ruukoto_task_start";
export const TASK_END_MARKER = "ruukoto_task_end";
