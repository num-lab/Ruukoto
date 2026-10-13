/**
 * 领域类型：项目、会话、任务、确认请求、工具操作、持久事件。
 *
 * 术语沿用根目录 CONTEXT.md：会话一次执行一个任务；任务可中断、可排队；
 * 确认请求绑定具体操作。状态机不含排列组合：中断原因、取消意图与外部效果
 * 是否确定分别记录在任务字段中。
 */

import { randomBytes } from "node:crypto";
import type { HistorySnapshot } from "./history.ts";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { DirIdentity } from "./dir-identity.ts";

export const PROTOCOL_VERSION = 20;

export interface ModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * 任务访问模式。
 * Note: 见 .agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md
 * Note: 见 .agents/notes/implemented/feature/2026-09-22-auto-review-mode.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
 * - confirm：请求确认模式。在已授权范围内自主执行（受限执行环境内），
 *   越界文件操作与外部网络以结构化审批请求逐次授权。
 * - full_access：完全访问模式。使用启动后台账户已有权限及用户环境，
 *   不施加任务沙箱、不请求操作审批，也不额外赋予 OS 权限。
 * - auto-review：自动审查模式。与 confirm 同一受限执行环境；越界的外部文件
 *   读取与无凭据 HTTP 读取先经独立审查调用自动审批（approve/reject/ask_owner），
 *   无法确认或审查失败一律转拥有者；不扩大授权范围，不升级为完全访问。
 */
export type AccessMode = "confirm" | "full_access" | "auto-review";

/**
 * 会话默认模式：新建任务在未显式指定模式时沿用；Plan 使用 auto-review
 * 访问策略，并固定任务的计划工作方式（issue 31）。
 */
export type SessionDefaultMode = AccessMode | "plan";

/** 会话默认模式的取值列表（显示与入参校验共用）。 */
export const SESSION_DEFAULT_MODES: readonly SessionDefaultMode[] = ["confirm", "full_access", "auto-review", "plan"];

/** 访问模式入参校验（CLI/控制面/运行时共用的类型守卫，消除字面量重复）。 */
export function isAccessMode(value: unknown): value is AccessMode {
  return value === "confirm" || value === "full_access" || value === "auto-review";
}

/** 会话与新任务可选择的模式；任务中切换仍只接受 AccessMode。 */
export function isSessionDefaultMode(value: unknown): value is SessionDefaultMode {
  return value === "plan" || isAccessMode(value);
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
  /** 创建幂等键（issue 21；null = 无键创建的旧记录）。 */
  createRequestId: string | null;
  /**
   * 工作区根目录身份（agent-direction issue 05）：非 null 即该项目是一个工作区，
   * 归属 realpath/dev+ino 对应的开发根目录，同名目录不会合并为一个工作区；
   * null = 旧架构项目（可能包含不同目录的会话），迁移见 issue 07。
   */
  rootDir: DirIdentity | null;
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
  /**
   * 项目设置版本（agent-direction issue 06）：只保护指令列表与 Web Search
   * 开关；任何变化递增，拥有者入口按期望版本做乐观并发校验。MCP、Jev 与
   * 会话默认继续使用各自的 configVersion/版本列，不合并为一个总版本。
   */
  settingsVersion: number;
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
 * SubAgent（agent-direction issue 11，一层 SubAgent 模型）：主 Agent
 * （普通开发会话或 main）为一项工作委托创建的动态从属身份。与旧固定角色
 * （AgentRoleId）分开保存；不创建下级、不直接与拥有者交互。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md
 * 状态：running = 有活动执行任务；idle = 任务终态且执行单元已核实退出；
 * unverified = 任务终态但旧执行单元退出未核实（占用保留）。
 * 关闭（issue 12）用独立列表示：state 继续只表示执行状态，关闭后拒绝新委派，
 * 历史、产物与工作目录保留可查；任务终态、TUI 退出与空闲不自动关闭。
 */
export type SubAgentState = "running" | "idle" | "unverified";

/** SubAgent 的关闭发起方：拥有者（控制面）或主 Agent（agent:<发起任务ID>）。 */
export type SubAgentClosedBy = "owner" | `agent:${string}`;

/** 工作委托的取消发起方（issue 14）：拥有者（控制面）或主 Agent（agent:<发起任务ID>）。 */
export type WorkCanceledBy = "owner" | `agent:${string}`;

/** 动态 SubAgent（sub_agents 表；宿主管理，模型与工作参数不能修改）。 */
export interface SubAgent {
  id: string;
  /** 所属父用户会话（工作委托归属；资料身份随该会话原项目）。 */
  parentSessionId: string;
  /** 独立子会话（JSONL 历史所在）。 */
  sessionId: string;
  /** 宿主生成的独立工作目录（保护根之外）。 */
  workDir: string;
  /** 当前承接的工作委托；null = 空闲无当前工作。 */
  activeWorkId: string | null;
  /** 当前活动任务；null = 无活动任务。 */
  currentTaskId: string | null;
  state: SubAgentState;
  /** 关闭时刻；null = 未关闭（可继续或复用）。 */
  closedAt: string | null;
  /** 关闭发起方；null = 未关闭。 */
  closedBy: SubAgentClosedBy | null;
  createdAt: string;
}

/**
 * 工作的写入目标（agent-direction issue 16，work_delegations.write_target JSON）：
 * 首次委派时钉定，继续委派沿用；null = 只读分析工作（无法升级为写入）。
 * - worktree：Git 目标的宿主生成 worktree（隔离副本；分支/基线/共享 Git 目录
 *   与目录身份全部钉定，继续委派逐项复核）；
 * - direct：非 Git 目标（父工作区内的目标目录，直接写入并与父会话串行）。
 */
export type WorkWriteTarget =
  | {
      kind: "worktree";
      /** 仓库根（目标路径向上找到的第一个含 .git 的目录）。 */
      repoRoot: string;
      /** 仓库共享 Git 目录（普通仓库 = <repoRoot>/.git；worktree = common dir）。 */
      commonGitDir: string;
      /** 本副本的 gitdir（.git 文件指向；普通仓库 = <repoRoot>/.git）。 */
      gitdir: string;
      path: string;
      dev: number;
      ino: number;
      branch: string;
      baseCommit: string;
    }
  | { kind: "direct"; path: string; dev: number; ino: number };

/** 读取 work_delegations.write_target（损坏按 null 处理，不阻断历史读取）。 */
export function parseWorkWriteTarget(json: string | null): WorkWriteTarget | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as WorkWriteTarget;
    if (v?.kind === "worktree") return v;
    if (v?.kind === "direct") return v;
    return null;
  } catch {
    return null;
  }
}

/** 写入 work_delegations.write_target（null = 清除；首版只写不清）。 */
export function writeTargetToJson(target: WorkWriteTarget | null): string | null {
  return target === null ? null : JSON.stringify(target);
}

/**
 * 工作委托（work_delegations 表）：拥有者交给主 Agent 的一项工作，可跨
 * 多轮对话、包含同一 SubAgent 的多次执行任务。与每次执行（Task）分开保存；
 * 一次任务终态不等于工作关闭。
 * 取消（issue 14）用独立列表示，一次写入：取消后拒绝继续委派，迟到结果
 * 保存为事实但不再送达父模型；历史、产物与工作记录保留可查。
 * 写入目标（issue 16）用独立可空列表示：null = 只读分析工作；非 null 即
 * 修改工作（worktree 隔离副本或父工作区内直接写入），首次委派钉定。
 */
export interface WorkDelegation {
  id: string;
  /** 所属父用户会话（普通开发会话或 main 角色会话）。 */
  parentSessionId: string;
  /** 发起任务（首次委派时的拥有者任务）。 */
  originTaskId: string;
  /** 首次承接的 SubAgent；协作加入的其他 SubAgent（issue 13）经 tasks 的关联列记录。 */
  subAgentId: string;
  /** 首次委派的幂等键（父会话内唯一）。 */
  requestKey: string;
  /** 首次委派规范化参数的 sha256（不含本次调用的父任务 id，跨轮次重放可核对）。 */
  paramsDigest: string;
  /** 取消时刻；null = 未取消。 */
  canceledAt: string | null;
  /** 取消发起方；null = 未取消。 */
  canceledBy: WorkCanceledBy | null;
  /** 取消原因（可选）；null = 未取消或未给原因。 */
  cancelReason: string | null;
  /** 写入目标（issue 16）；null = 只读分析工作（不能升级为写入）。 */
  writeTarget: WorkWriteTarget | null;
  createdAt: string;
}

/**
 * 工作内协作消息（agent-direction issue 13，subagent_messages 表）：同一项工作
 * 的参与者（主 Agent 与当前承接本工作的各 SubAgent）之间有来源的消息。
 * - from/to 的 null 端 = 主 Agent（父会话），非 null = SubAgent；
 * - 幂等键按（工作, 发送方, 键）核实：同键同参返回原记录，异参冲突；
 * - 投递：发给 SubAgent 的投递为本工作内的一次执行任务（delivered_task_id），
 *   发给主 Agent 的经 dev 注入（结果通道）或 main 唤醒任务送达；
 *   接收方正忙/名额满时保持待投递（delivered_* 与 undelivered_reason 均空），
 *   由宿主机在终态/启动/取消/关闭时冲刷；资格已失（转做其他工作、已关闭、
 *   工作已取消）记 undelivered_reason，不再投递；
 * - 消息只携带正文与来源，不扩大接收方的工具与资料范围。
 */
export interface SubAgentMessage {
  id: string;
  workId: string;
  /** 所属父用户会话（范围核实与注入查询的归属）。 */
  parentSessionId: string;
  /** 发送的 SubAgent；null = 主 Agent。 */
  fromSubAgentId: string | null;
  /** 发送方发起任务（来源可追溯）。 */
  fromTaskId: string;
  /** 登记消息时的发起任务模式与权限版本；延迟投递不重新取会话默认值。 */
  accessMode: AccessMode;
  sourcePermissionVersion: number;
  /** 接收的 SubAgent；null = 主 Agent。 */
  toSubAgentId: string | null;
  /** 发送方提供的幂等键。 */
  requestKey: string;
  /** 规范化参数的 sha256（同键异参冲突核实）。 */
  paramsDigest: string;
  body: string;
  createdAt: string;
  /** 投递任务的 id（SubAgent 投递任务 / main 唤醒任务；dev 注入无任务为 null）。 */
  deliveredTaskId: string | null;
  /** 投递登记时刻；null = 未投递。 */
  deliveredAt: string | null;
  /** 无法投递的明确结果（如 closed / moved_work / work_canceled）；null = 未判定。 */
  undeliveredReason: string | null;
}

/**
 * 跨实例导入回执（agent-direction issue 21，instance_imports 表）：旧 ruukoto
 * 实例经目标侧离线 legacy-import 迁入新档案的一次导入记录——issue 21 为开发
 * 资料迁入 Coding Agent，issue 22 为个人资料迁入全新 ruukoto（两方向共用本表，
 * 按目标产品分流）。导入由目标侧离线 CLI 执行，源实例全程只读；回执持久保留
 * （含 reverted 状态），供续跑幂等核实、回退与整库恢复定位。
 */
export interface InstanceImport {
  id: string;
  /** 请求键：CLI 由计划文件内容派生；同键同参重放返回本回执。 */
  requestKey: string;
  sourceInstanceId: string;
  /** 源实例登记的产品（旧库可能未登记）。 */
  sourceProduct: string | null;
  /** 源库原始 schema 版本（快照迁移前读取）。 */
  sourceSchemaVersion: number | null;
  sourceDir: string;
  /** 规范化计划的规范化哈希：同键异参报 request_conflict。 */
  planDigest: string;
  /** 导入前对目标库的备份（VACUUM INTO）；整库恢复的手工路径。 */
  targetBackupPath: string;
  targetBackupSha256: string;
  /** 导入事件在目标事件日志中的 seq 区间（闭区间；无事件恒为 null）。 */
  eventSeqFrom: number | null;
  eventSeqTo: number | null;
  /** 导入报告 JSON（收尾动作、文件 sha256、待处理项与排除清单）。 */
  report: string;
  status: "applied" | "reverted";
  createdAt: string;
  revertedAt: string | null;
}

/** 导入条目账本类别（instance_import_items）；同一资料（kind, item_id）至多归属一次导入。
 *  issue 21 方向用前九类；issue 22 个人方向另用 agent_role/schedule/platform_config/
 *  standing_permission/credential（v30 起）。 */
export type InstanceImportItemKind =
  | "project"
  | "session"
  | "sub_agent"
  | "work_delegation"
  | "memory"
  | "grant"
  | "mcp"
  | "meta"
  | "file"
  | "agent_role"
  | "schedule"
  | "platform_config"
  | "standing_permission"
  | "credential";

/** 导入条目账本行：标识某项资料属于哪次导入（回退按账本删行）。 */
export interface InstanceImportItem {
  kind: InstanceImportItemKind;
  itemId: string;
  importId: string;
}

/**
 * SubAgent 任务的限定资料范围（tasks.read_scope JSON）：
 * - paths：宿主钉定的只读路径（经 worker init 传入，模型参数不能替换）；
 *   每个路径保存规范化 realpath 与目录身份（dev/ino 供启动复核）。
 * - sourceRefs：main 选定资料的来源引用（启动与每次发送上下文前重新 verify）。
 */
export interface SubAgentReadScope {
  paths: Array<{ path: string; dev: number; ino: number; purpose: string }>;
  sourceRefs: unknown[];
}

/**
 * 工具类别：按工具注册来源划分（编码工具/宿主资料与记忆/Web Search/MCP/应用数据/
 * 调度/委派/群结果/服务器服务/技能）。各会话类别开放哪些类别由 tool-availability
 * 的清单决定，装配、激活、发送前与调用门共用同一结论；app_data、scheduler、
 * delegation、chat_results、service 只在 main 的清单中（service 另要求产品与
 * 部署配置具备，见 tool-availability 与 Driver 装配）。
 */
export type ToolCategory = "coding" | "host_data" | "web_search" | "mcp" | "app_data" | "scheduler" | "delegation" | "chat_results" | "service" | "skills" | "subagent";

/**
 * 可信宿主配置的通知目标（issue 03）：渠道、账号、会话 ID 与配置版本。
 * 只能来自宿主；模型不能传入 URL、chat/user ID 或凭据。版本变化使旧授权失效。
 */
export interface NotifyTarget {
  channel: string;
  account: string;
  chatId: string;
  configVersion: number;
}

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

/** main 显式接收的群聊结果快照；不授予原始群历史或产物的读取权。 */
export interface AcceptedChatResult {
  taskId: string;
  mainProjectId: string;
  acceptedByTaskId: string;
  acceptedByOpId: string;
  reason: string;
  summary: string;
  acceptedAt: string;
}

/** 入站事件处理状态：registered（已登记未建任务）→ queued → done / failed。 */
export type InboundEventStatus = "registered" | "queued" | "done" | "failed";

/**
 * 入站事件类别（宿主写定，agent-direction issue 08）：task = 普通任务入站；
 * im_approval = IM 审批控制消息（查询/批准/拒绝命令），直接在同步事务内到终态，
 * 不派发模型任务。类别不能由消息正文或模型参数决定；旧记录默认 task。
 */
export type InboundEventKind = "task" | "im_approval";

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
  /** QQ 私聊与群聊由宿主在收件时固定目标及配置版本；其他来源按各入口规则核对。 */
  replyTarget: NotifyTarget | null;
  receivedAt: string;
  /** 宿主写定的事件类别（旧记录默认 task）。 */
  eventKind: InboundEventKind;
  status: InboundEventStatus;
  /** 由本事件创建的任务（queued 时回填）。 */
  taskId: string | null;
}

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";
export type InboundMediaMessageStatus = "staging" | "ready" | "bound" | "rejected" | "expired";
export type InboundMediaStatus = "pending" | "downloading" | "ready" | "promoted" | "rejected" | "expired";

/** 下载 URL 与凭据仅存在于适配器闭包；此信封足以恢复已下载但尚未登记的消息。 */
export interface InboundMediaMessage {
  id: string;
  source: string;
  externalId: string;
  actor: string | null;
  body: string;
  replyTarget: NotifyTarget | null;
  receivedAt: string;
  mediaCount: number;
  mediaRefs: string[];
  status: InboundMediaMessageStatus;
  reason: string | null;
  eventId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InboundMedia {
  id: string;
  messageId: string;
  source: string;
  externalId: string;
  mediaIndex: number;
  declaredMime: string | null;
  mimeType: ImageMimeType | null;
  byteCount: number;
  contentHash: string | null;
  fileName: string;
  status: InboundMediaStatus;
  reason: string | null;
  eventId: string | null;
  taskId: string | null;
  artifactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionBranchSource {
  sessionId: string;
  number: number;
  entryId: string;
  messageCount: number;
  excluded: string[];
  /** 宿主核实的历史任务与已有产物；不参与任务执行或工作管理授权。 */
  taskIds: string[];
  artifacts: Artifact[];
  results: Array<{ workId: string; taskIds: string[] }>;
}

export interface Session {
  id: string;
  name: string | null;
  branchSource: SessionBranchSource | null;
  projectId: string;
  /**
   * 工作区组织归属（agent-direction issue 07）：非 null 即会话在组织查询与普通
   * 列表中归属该工作区项目（目标必须带根目录归属）。只是展示归属：资料身份与
   * 配置来源仍是 projectId，AccessScope、模型工具身份与凭据范围判定不使用本字段。
   * null = 未映射，按来源项目归属展示。
   */
  workspaceProjectId: string | null;
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
  /** 创建幂等键（issue 21；null = 无键创建的旧记录）。 */
  createRequestId: string | null;
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
  /** 提交时固定的计划工作方式；为 true 时访问策略恒为 auto-review。 */
  planMode: boolean;
  /** 本任务的权限版本；模式或路径授权变化时递增，旧审批消费时核对。 */
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
  /** 宿主派生任务登记时的发起任务权限版本；来源任务由 parentTaskId 关联。 */
  sourcePermissionVersion: number | null;
  /** 来源入站事件 id（null = 非事件触发）。 */
  sourceEventId: string | null;
  /** 截止时间（ISO；超时由编排器取消；null = 无期限）。 */
  deadline: string | null;
  /** 结构化结果摘要（终态后由编排器记录，一次写入；null = 尚未记录）。 */
  resultSummary: string | null;
  /** 结果引用（JSON：完整结果的查询位置，如 {"sessionId","taskId"}）。 */
  resultRef: string | null;
  /**
   * SubAgent 执行任务的关联（agent-direction issue 11；旧任务恒为空）：
   * 所属工作委托与执行身份。动态 ID 不进入 agent_id（旧角色 CHECK 不变）。
   */
  workId: string | null;
  subAgentId: string | null;
  /** 本任务的限定资料范围（SubAgent 任务；null = 无钉定范围）。 */
  readScope: SubAgentReadScope | null;
  /** 结果已注入父会话某次模型上下文的时刻（dev 父会话的结果注入；null = 尚未注入）。 */
  resultDeliveredAt: string | null;
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
      operationCategory: "read" | "write" | "unknown";
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
      /** 固定一次通知的正文、目标、来源任务与操作；完全访问使用任务授权，其余模式单次批准。 */
      kind: "notification";
      mode: "once";
      taskId: string;
      toolOpId: string;
      target: NotifyTarget;
      textSha256: string;
      textChars: number;
      /** 来源引用摘要（正文已在登记前解析为最终文本）。 */
      sourceRefs: string[];
    }
  | {
      /**
       * 服务器服务管理（agent-direction issue 09）：固定本机身份、
       * 白名单内的规范单元名、固定动作、策略与单元定义修订，以及发起任务和
       * 宿主操作 ID。完全访问使用任务授权，受限模式单次消费批准；OS 权限
       * 仍由固定 helper 核实。活动状态、PID、
       * InvocationID 属于观察结果，不进入修订指纹。
       * Note: 见 .agents/notes/implemented/architecture/2026-10-03-service-management-helper.md
       */
      kind: "service_operation";
      /** 本机身份（policy.machineId，helper 每次调用与 /etc/machine-id 核对）。 */
      machineId: string;
      /** 白名单内的规范 .service 单元名（精确匹配，无别名/模板/通配符）。 */
      unit: string;
      /** 固定动作（首版仅 restart；restart 会启动原本不活动的服务）。 */
      action: "restart";
      /** 请求时的策略内容 sha256；消费前同步重读核对。 */
      policyRevision: string;
      /** 请求时的单元定义修订（fragment/drop-in 内容指纹 + 已加载状态）。 */
      unitRevision: string;
      /** 发起任务与宿主操作（审批范围的固定锚点；helper 操作单元由它派生）。 */
      taskId: string;
      toolOpId: string;
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
  /** 最终决定来源：owner = 拥有者；auto_review = 自动审查；standing_permission = 经长期授权（见关联列）。 */
  decisionSource: "owner" | "auto_review" | "standing_permission" | null;
  /**
   * 关联的长期授权（agent-direction issue 10；null = 普通批准）：/approve-standing
   * 的当前批准与每次自动放行都钉版授权 ID 与版本；消费时在公共消费处重读，
   * 撤销/版本变化即不再放行。旧记录恒为 null（迁移不把旧批准转成长期授权）。
   */
  standingPermissionId: string | null;
  standingPermissionVersion: number | null;
}

/**
 * 长期操作授权（agent-direction issue 10）：
 * Note: 见 .agents/notes/implemented/feature/2026-10-03-standing-permissions.md
 * 拥有者经原 IM 平台的待审批明确保存的限定授权——允许本机对指定白名单服务执行
 * 固定动作（首版仅 restart）。授权存放于后台保护的核心库，模型、子任务消息与
 * 普通平台文本都不能创建或扩大；范围创建后不修改，修改经撤销后新建完成。
 *
 * 失效：撤销（owner_revoked）或核实失败后明确失效（入口代次/身份变化
 * entry_changed、策略/单元修订不符 revision_changed、目标效果未知 effect_unknown），
 * 都递增版本并保留记录；同一 main 会话、同一稳定入口身份与同一目标最多一条
 * 未撤销授权。使用资格逐项核实（原目标代次、main、本机/单元/动作与两项修订），
 * 共享主会话不使另一平台继承授权。
 */
export interface StandingPermission {
  id: string;
  /** 修订版本（创建为 1；撤销/失效递增，条件更新防重复变更）。 */
  version: number;
  /** 授权目标：main 会话及资料身份。 */
  sessionId: string;
  projectId: string;
  /** 入口身份：机器/单元/动作与入口绑定逐项核实用的钉版字段。 */
  machineId: string;
  unit: string;
  action: "restart";
  /** 创建时的策略/单元修订指纹；使用资格核实（变化即不再自动放行）。 */
  policyRevision: string;
  unitRevision: string;
  /** 原 IM 入口与拥有者绑定（稳定键：channel/account/chatId/actor）。 */
  channel: string;
  account: string;
  chatId: string;
  /** 当前 IM actor（拥有者平台身份）。 */
  actor: string;
  /** 创建时钉版的 NotifyTarget（含配置版本；代次变化即失效）。 */
  pinnedTarget: NotifyTarget;
  /** 来源审批（唯一）与创建控制事件。 */
  approvalId: string;
  createdByEventId: string;
  createdAt: string;
  /** 撤销/失效时间与原因；非 null 即已失效。 */
  revokedAt: string | null;
  revokedReason: string | null;
}

/** 工具执行依据；完全访问与单次批准分别留存，不伪造拥有者决定。 */
export type ToolAuthorization =
  | { source: "full_access"; taskId: string; permissionVersion: number; scope: ApprovalScope }
  | { source: "approval"; taskId: string; permissionVersion: number; confirmationId: string; scope: ApprovalScope };

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
  authorization: ToolAuthorization | null;
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
  /** 图片产物的不可变 MIME 与 SHA-256；旧工具正文产物为空。 */
  mimeType?: ImageMimeType | null;
  contentHash?: string | null;
  createdAt: string;
}

export interface EditStats {
  added: number;
  removed: number;
}

/** 持久事件载荷（JSON 序列化后存 events.payload）。 */
export type PersistentEventBody =
  | { type: "workflow.changed"; runId: string; version: number; status: import("./workflow.ts").WorkflowRun["status"]; reason: string | null }
  | { type: "workflow.step"; runId: string; key: string; status: import("./workflow.ts").WorkflowStep["status"]; delivery: number | null }
  | { type: "workflow.execution"; runId: string; taskId: string; kind: "agent" | "host"; status: "queued" | "running" | "finished"; stopVerified: boolean | null }
  /** 模型配置已在线应用（issue 21 §4）：载荷不含任何秘密，供前端刷新配置视图。 */
  | { type: "model.config_changed"; kind: "catalog" | "api_key" | "default_model" | "summary_model"; provider?: string }
  | { type: "project.created"; projectId: string; name: string; createRequestId: string | null; rootDir?: DirIdentity | null }
  /** 旧项目认领工作区根目录（agent-direction issue 05）；认领后该项目即工作区。 */
  | { type: "project.root_attached"; projectId: string; rootDir: DirIdentity }
  | { type: "project.jev_changed"; projectId: string; configVersion: number; enabled: boolean }
  /**
   * 项目指令列表与 Web Search 开关已保存（agent-direction issue 06）：携带设置
   * 版本与可供视图更新的配置字段；不含指令正文或秘密。冲突的保存不产生本事件。
   */
  | { type: "project.settings_changed"; projectId: string; settingsVersion: number; instructionFiles: string[]; webSearch: "enabled" | "disabled" }
  | { type: "session.created"; sessionId: string; projectId: string; kind: SessionKind; cwd: string; modelSelection: ModelSelection | null; modelSelectionVersion: number; createRequestId: string | null; session?: Session }
  /**
   * 会话工作区组织归属已设置（agent-direction issue 07）：仅组织展示归属，资料
   * 身份与配置来源仍是 projectId；目标必须带根目录归属。null = 恢复未映射。
   */
  | { type: "session.workspace_mapped"; sessionId: string; projectId: string; workspaceProjectId: string | null }
  | { type: "session.model_selection_changed"; sessionId: string; modelSelection: ModelSelection; modelSelectionVersion: number }
  | { type: "session.default_mode_changed"; sessionId: string; defaultAccessMode: SessionDefaultMode; defaultAccessModeVersion: number }
  | { type: "session.context_compaction"; sessionId: string; requestId: string; status: SessionCompactionRequest["status"] }
  | { type: "tasks.model_selection_recorded"; sessionId: string; taskIds: string[]; modelSelection: ModelSelection }
  | { type: "task.queued"; taskId: string; sessionId: string; requestId: string; accessMode: AccessMode; parentTaskId?: string | null; sourcePermissionVersion?: number | null; planMode: boolean; modelSelection: ModelSelection | null }
  | { type: "task.started"; taskId: string; sessionId: string }
  /** Jev 选择尝试；即使主模型未发送，取消与回退仍有任务归属记录。 */
  | { type: "task.context_experiment"; taskId: string; sessionId: string; experiment: ContextExperimentRecord }
  /**
   * 上下文压缩（issue 30）：started = 开始调用摘要模型；finished = 压缩点落盘（与压缩点同一事务），
   * 摘要失败且清理收益不足时 checkpointId 为 null（未建压缩点）。
   */
  | {
      type: "task.context_compaction"; taskId: string; sessionId: string; compactionId: string; phase: "started" | "finished";
      checkpointId: string | null; summaryModel: string | null; estimateBefore: number;
      estimateAfter?: number; clearedResults?: number; summarizedCount?: number;
      summaryStatus?: ContextCheckpoint["summaryStatus"]; summaryError?: string | null;
    }
  | { type: "task.awaiting_confirmation"; taskId: string; confirmationId: string; toolOpId: string; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean; scope: ApprovalScope; permissionVersion?: number; reviewStatus?: "in_progress" | null; reviewModel?: string | null; reviewPolicyVersion?: string | null }
  | { type: "task.confirmation_resolved"; taskId: string; confirmationId: string; decision: "approved" | "rejected"; source?: "owner" | "auto_review" | "standing_permission"; reason?: string; standingPermissionId?: string; standingPermissionVersion?: number }
  /** 自动审查转人工（issue 15）：审批仍 pending，等待拥有者决定。 */
  | { type: "task.confirmation_reviewed"; taskId: string; confirmationId: string; decision: "ask_owner"; reason: string }
  | { type: "task.approval_consumed"; taskId: string; confirmationId: string; toolOpId: string; toolName: string; standingPermissionId?: string; standingPermissionVersion?: number }
  | { type: "task.tool_authorized"; taskId: string; toolOpId: string; authorization: ToolAuthorization }
  /** 长期操作授权已保存（agent-direction issue 10）：范围不可变，来源审批唯一。 */
  | { type: "standing_permission.created"; permissionId: string; approvalId: string; eventId: string; sessionId: string; channel: string; account: string; chatId: string; actor: string; machineId: string; unit: string; action: string }
  /** 长期操作授权已撤销/失效（版本递增，保留记录；重复撤销不产生本事件）。 */
  | { type: "standing_permission.revoked"; permissionId: string; version: number; reason: "owner_revoked" | "effect_unknown" | "entry_changed" | "revision_changed"; opId?: string }
  | { type: "task.mode_switch_requested"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode }
  | { type: "task.mode_switched"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode; permissionVersion: number }
  | { type: "task.mode_switch_failed"; taskId: string; sessionId: string; to: AccessMode; reason: string }
  /**
   * 运行中输出：contentIndex 是后台分配的连续正文段序号（不等同 SDK
   * 块索引，部分 provider 在思考/正文交错时复用 SDK 索引）。offset/totalBytes
   * 是该段的 UTF-8 字节偏移/累计大小；无 contentIndex 时作用于整条消息。
   * 无 offset 的旧事件为累计文本尾部。startedAt 是该段首次实际正文时间。
   * message_end 会冲刷所有段；最终消息以 output_entry 关联的 JSONL 为准。
   */
  | { type: "task.output_fragment"; taskId: string; sessionId: string; messageId: string; text: string; totalBytes: number; truncated: boolean; partial: true; offset?: number; startedAt?: string; contentIndex?: number }
  | { type: "task.thinking"; taskId: string; sessionId: string; thinkingId: string; messageId: string; startedAt: string; endedAt: string | null; text: string }
  | { type: "task.output_entry"; taskId: string; sessionId: string; entryId: string; sessionFile: string; role: string; messageId: string | null }
  /**
   * 工具/审批事件（线上载荷）：params 可能被替换为有界预览
   * （paramsTruncated=true，paramsBytes 为完整序列化字节数）；完整参数经
   * get_confirmation_params / get_tool_op_params 按 ID 分段读取。持久化的事件正文保持完整。
   */
  | { type: "task.tool_intent"; taskId: string; toolOpId: string; sdkCallId: string | null; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean }
  | { type: "task.tool_result"; taskId: string; toolOpId: string; summary: string; isError: boolean; artifactIds: string[]; editStats?: EditStats }
  | { type: "task.tool_effect_unknown"; taskId: string; toolOpId: string; toolName: string }
  | { type: "task.tool_process_unreaped"; taskId: string; sessionId: string; reason: string }
  | { type: "task.completed"; taskId: string; sessionId: string }
  | { type: "task.failed"; taskId: string; sessionId: string; errorMessage: string }
  | { type: "task.canceled"; taskId: string; sessionId: string }
  | { type: "task.interrupted"; taskId: string; sessionId: string; reason: string; cancelRequested: boolean; effectUnknown: boolean }
  | { type: "task.continued"; taskId: string; sessionId: string; resumesTaskId: string }
  | { type: "session.queue_paused"; sessionId: string; reason: string }
  | { type: "session.usage_updated"; sessionId: string }
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
  | { type: "qq.config_changed"; configVersion: number; action: "upsert" | "enabled" | "disabled" | "group_added" | "group_removed" | "credential_changed"; groupId?: string }
  /**
   * QQ 接收缺口（issue 07）：连接中断后重连成功时标记中断窗口——断线期间的
   * 群消息不假定平台会重投，缺失如实记录，不补抓、不补发。
   */
  | { type: "qq.receive_gap"; from: string; to: string }
  /** Telegram owner 入口配置变化（issue 04）：不含 token；configVersion 随变化递增。 */
  | { type: "telegram.config_changed"; configVersion: number; action: "upsert" | "enabled" | "disabled" | "credential_changed" }
  /** 非 owner / 非私聊 / 非文本消息被忽略（只记 id 与原因，不含正文，不建任务）。 */
  | { type: "telegram.rejected"; updateId: number; chatId: string | null; userId: string | null; reason: string }
  /** 私聊入站任务终态但未登记 owner 回复（目标未配置、停用或版本变化）。 */
  | { type: "telegram.reply_skipped"; eventId: string; taskId: string; reason: string }
  | { type: "qq_private.reply_skipped"; eventId: string; taskId: string; reason: string }
  | { type: "backend.started"; dataDir: string; executionBackend: string; product: string }
  | { type: "backend.stopping"; reason: string }
  | { type: "backend.stopped"; reason: string }
  | { type: "backend.recovered"; interruptedTaskIds: string[]; pausedSessionIds: string[] }
  /** 入站事件已登记（issue 01；先持久化再建任务，重复登记不产生新事件）。 */
  | { type: "inbound.registered"; eventId: string; source: string; externalId: string; targetRole: AgentRoleId; actor: string | null }
  /** 入站事件已建任务并入队。 */
  | { type: "inbound.queued"; eventId: string; taskId: string; targetRole: AgentRoleId }
  | { type: "inbound.skipped"; eventId: string; source: string; reason: string }
  /** IM 审批控制消息处理结果（agent-direction issue 08；控制事件与回执同事务落盘）。 */
  | { type: "im_approval.processed"; eventId: string; source: string; commandKind: string; outcome: string }
  /** 同幂等键重投的命令与记录不一致：拒绝执行与原回执（不覆盖既有事实）。 */
  | { type: "im_approval.redelivery_rejected"; eventId: string; source: string; externalId: string; reason: string }
  | { type: "chat_result.accepted"; taskId: string; acceptedByTaskId: string; acceptedByOpId: string }
  /** 子任务完成（结果摘要与引用已记录在任务上）。 */
  | { type: "child_task.completed"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; summary: string; resultRef: string }
  | { type: "child_task.failed"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; errorMessage: string }
  /** 子任务超过截止时间被编排器取消。 */
  | { type: "child_task.timeout"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; deadline: string }
  /** 子任务结果未知（如后台重启中断）；不自动重放任何外部副作用。 */
  | { type: "child_task.result_unknown"; taskId: string; parentTaskId: string | null; agentId: AgentRoleId; reason: string }
  /** 工作委托已登记（agent-direction issue 11）：原子登记工作/Agent/会话/任务的审计记录。 */
  | { type: "work_delegation.created"; workId: string; parentSessionId: string; subAgentId: string; agentSessionId: string; taskId: string }
  /** SubAgent 执行任务终态（结果摘要与引用已记录在任务上；refs 指向父会话，供 TUI 归属展示）。 */
  | { type: "subagent_task.completed"; workId: string; subAgentId: string; taskId: string; parentSessionId: string; parentTaskId: string; summary: string; resultRef: string }
  | { type: "subagent_task.failed"; workId: string; subAgentId: string; taskId: string; parentSessionId: string; parentTaskId: string; errorMessage: string }
  | { type: "subagent_task.timeout"; workId: string; subAgentId: string; taskId: string; parentSessionId: string; parentTaskId: string; deadline: string }
  | { type: "subagent_task.result_unknown"; workId: string; subAgentId: string; taskId: string; parentSessionId: string; parentTaskId: string; reason: string }
  /** SubAgent 已显式关闭（issue 12；taskId = 主 Agent 关闭的发起任务，拥有者关闭为 null）。 */
  | { type: "subagent.closed"; subAgentId: string; parentSessionId: string; closedBy: SubAgentClosedBy; taskId: string | null }
  /**
   * 工作委托已取消（agent-direction issue 14）：取消登记时同事务落盘；
   * canceledTaskIds = 事务内直接取消的排队任务，stoppingTaskIds = 写取消意图、
   * 提交后按停止路径处理的活动任务。
   */
  | { type: "work_delegation.canceled"; workId: string; parentSessionId: string; subAgentId: string; canceledBy: WorkCanceledBy; reason: string | null; canceledTaskIds: string[]; stoppingTaskIds: string[] }
  /**
/**
   * 工作内协作消息已登记（agent-direction issue 13）：与消息行同事务落盘，
   * 每条消息至多一条（含登记时的投递判定）；delivery：task = 已投递为接收方
   * 的本工作任务（taskId 非空）；wake = 已投递为 main 唤醒任务；inject = 待
   * dev 父会话注入；pending = 接收方正忙/名额满，宿主机在终态/启动时冲刷。
   * 同键同参命中不再产生事件；冲刷改变行与任务但不补发本事件，未送达的
   * 最终结果由 subagent_message.dropped 记录。
   */
  | { type: "subagent_message.sent"; messageId: string; workId: string; parentSessionId: string; fromSubAgentId: string | null; fromTaskId: string; toSubAgentId: string | null; delivery: "task" | "wake" | "inject" | "pending"; taskId: string | null }
  /** 工作内消息最终无法投递（接收方资格已失或工作已取消）；与判定同事务落盘。 */
  | { type: "subagent_message.dropped"; messageId: string; workId: string; parentSessionId: string; toSubAgentId: string | null; reason: string }
  /**
   * worktree 副本的改动已汇入父工作区（agent-direction issue 17）：taskId =
   * 发起汇总的主任务（直接父任务）；来源按（分支, baseCommit）钉定，parentHead
   * 是汇总时刻父仓库 HEAD（null = 读取失败）；文件清单与统计来自汇总时的完整
   * 差异（files 有界，上限见 INTEGRATE_FILE_LIST_CAP；超出只计数不列名）。只在
   * 真实套用时登记（幂等命中、空差异与冲突不登记）。
   */
  | { type: "work_delegation.integrated"; workId: string; parentSessionId: string; subAgentId: string; taskId: string; branch: string; baseCommit: string; parentHead: string | null; files: string[]; filesChanged: number; insertions: number; deletions: number; patchBytes: number }
  /**
   * 应用数据能力不可用（issue 02）：main.db 丢失、实例身份不符、损坏或存储
   * 格式过新/迁移失败。不自动重建、不覆盖既有实例绑定；工具保持关闭。
   */
  | { type: "app_data.unavailable"; reason: string }
  /**
   * 应用数据操作被拒绝（issue 02）：调用门/身份校验/参数校验/预算超限/超时。
   * 只记来源、操作类别与错误码，不复制无限长输入或整条个人数据。
   */
  | { type: "app_data.rejected"; taskId: string | null; sessionId: string | null; source: "identity" | "validation" | "budget" | "timeout"; toolName: string; code: string }
  /** 调度计划变化（issue 03）：创建/取消/一次性完成。只落事件表，不唤醒模型。 */
  | { type: "schedule.changed"; scheduleId: string; action: "created" | "canceled" | "completed"; version: number; source: string; reason?: string }
  /** 调度运行：登记（含延迟/合并区间）、合并漏过周期、关闭。 */
  | { type: "schedule.run"; scheduleId: string; runId: string; action: "registered" | "coalesced" | "closed"; scheduledFor: string; delayMs?: number; coalescedFrom?: string | null; coalescedTo?: string | null }
  /** 发送操作状态（不含正文与凭据）。 */
  | { type: "notification.changed"; opId: string; status: "pending" | "sending" | "sent" | "failed" | "effect_unknown" | "canceled"; sourceKind: string; reason?: string };

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

/** Provider 实际用量；可选缓存与费用字段只在 SDK 提供时保留。 */
export interface SelectionUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** 有界的上下文实验结果，不含候选正文、服务响应正文或凭据。 */
export interface ContextExperimentRecord {
  status: "applied" | "fallback" | "skipped" | "canceled";
  strategy: string;
  requestedModel: string;
  model: string | null;
  configVersion: number;
  threshold: number;
  elapsedMs: number;
  requestSent: boolean;
  usage: { inputTokens: number; outputTokens: number } | null;
  /** 按指定日期公开单价估算，仅含 Jev；未知用量保持 null。 */
  estimatedCost: { usd: number; inputUsdPerMillion: number; priceDate: string } | null;
  fallbackReason: string | null;
  candidates: Array<{ id: string; indices: number[]; probability: number | null }>;
  baselineIncludedIndices: number[];
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
  /** 技能库钉版版本（issue 22；空串 = 无技能库；旧记录缺省为空串）。 */
  skillVersion?: string;
  /** 模型视图中被有界替换的工具结果（原消息序号 + 原/视图字符数；原文不动）。 */
  cappedToolResults: Array<{ index: number; originalChars: number; viewChars: number }>;
  /** 估算明细（分类 token 估计）。 */
  estimates: Record<string, number>;
  /** 总预算与估算合计。 */
  budget: number;
  estimatedTotal: number;
  /** 发送后补记的实际 provider usage（可空：失败/中断时无）。 */
  usage: SelectionUsage | null;
  /** 默认关闭及旧记录均为 null；可选字段兼容旧客户端与本地记录构造。 */
  experiment?: ContextExperimentRecord | null;
  /** 发送前捕获的不可变输入快照（产物 id；空 = 该次 prompt 正文未记录）。 */
  promptArtifactId: string | null;
  /** 窗口与预留快照（null = 旧记录无快照，无法计算总窗口占比）。 */
  windowSnapshot: WindowSnapshot | null;
  /** 本次视图使用的压缩点（issue 30；旧记录与无压缩点时为 null）。 */
  checkpointId?: string | null;
  createdAt: string;
}

/**
 * 上下文压缩点（issue 30）：每个会话至多一个 active。
 * Note: 见 .agents/notes/implemented/architecture/2026-09-26-lossy-context-compaction.md
 */
export interface ContextCheckpoint {
  id: string;
  sessionId: string;
  status: "active" | "superseded" | "invalidated";
  /** S：分支前 S 条消息由摘要替代。 */
  summarizedCount: number;
  /** C（≥ S）：[S, C) 的大工具结果换成占位说明。 */
  clearedCount: number;
  /** 前 C 条消息的角色、时间戳与工具调用 id 的 SHA-256。 */
  fingerprint: string;
  summary: string | null;
  /** 第 S 条消息的时间戳（UTC ISO）。 */
  summaryUntil: string | null;
  /** 被清理结果的 toolCallId → 条目 id（null = 会话文件中未找到）。 */
  clearedRefs: Record<string, string | null>;
  clearedResults: number;
  /** 本次压缩调用的摘要模型（provider/modelId；未调用为 null）。 */
  summaryModel: string | null;
  /** ok = 本次生成了新摘要；failed = 摘要失败只做了清理；none = 本次未调用摘要模型。 */
  summaryStatus: "ok" | "failed" | "none";
  summaryError: string | null;
  promptVersion: string;
  usage: Record<string, unknown> | null;
  estimateBefore: number;
  estimateAfter: number;
  taskId: string | null;
  callIndex: number | null;
  /** 手动来源可跨分支与实例保留；它不授予原请求的操作资格。 */
  manualRequestId?: string | null;
  createdAt: string;
}

/** 手动压缩的持久请求；历史与旧点固定后只允许一个终态。
 * Note: 见 .agents/notes/implemented/feature/2026-10-11-manual-context-compaction.md
 */
export interface SessionCompactionRequest {
  requestId: string;
  sessionId: string;
  prompt: string | null;
  paramsDigest: string;
  modelSelection: ModelSelection;
  summaryModel: { provider: string; modelId: string };
  source: Omit<HistorySnapshot, "entries"> | null;
  expectedCheckpointId: string | null;
  status: "running" | "succeeded" | "noop" | "failed" | "cancelled" | "interrupted";
  checkpointId: string | null;
  summarizedCount: number;
  estimateBefore: number | null;
  estimateAfter: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  endedAt: string | null;
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
