/**
 * 领域类型：项目、会话、任务、确认请求、工具操作、持久事件。
 *
 * 术语沿用根目录 CONTEXT.md：会话一次执行一个任务；任务可中断、可排队；
 * 确认请求绑定具体操作。状态机不含排列组合：中断原因、取消意图与外部效果
 * 是否确定分别记录在任务字段中。
 */

import { randomBytes } from "node:crypto";
import type { AttachmentMetadata, AttachmentReference } from "./attachments.ts";
import type { HistorySnapshot } from "./history.ts";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { DirIdentity } from "./dir-identity.ts";
import type { SubAgentDefinitionSnapshot } from "./subagent-definition.ts";
import type { SubAgentExecutionSnapshot } from "./subagent-execution.ts";
import type { WorkCopyHostSnapshot } from "./work-copy-host.ts";
import { requireWorkspaceSnapshot, WorkspaceSnapshotError, type WorkspaceSnapshot } from "./workspace-snapshot.ts";

export const PROTOCOL_VERSION = 50;

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

import { TERMINAL_TASK_STATUSES } from "./task-status.ts";
export { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from "./task-status.ts";

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export interface Project {
  id: string;
  name: string;
  /** 创建幂等键（issue 21；null = 无键创建的旧记录）。 */
  createRequestId: string | null;
  /** Registered workspace root, pinned by realpath and device/inode. */
  rootDir: DirIdentity | null;
  /** Host-created workspace for a chat started without an owner-selected directory. */
  managed?: boolean;
  /**
   * 项目指令文件（工作区相对路径，拥有者显式配置；issue 05 §3）。
   * 任务开始时经受限路径读取并钉版本；空数组 = 无项目指令。
   */
  instructionFiles: string[];
  /**
   * 项目设置版本（agent-direction issue 06）：只保护指令列表；任何变化递增，
   * 拥有者入口按期望版本做乐观并发校验。MCP、Jev 与会话默认继续使用各自的
   * configVersion/版本列，不合并为一个总版本。
   */
  settingsVersion: number;
  createdAt: string;
}

export type SessionQueueState = "active" | "paused";

/** Host-created development conversation category. */
export type SessionKind = "dev";

/**
 * A SubAgent is a one-level child identity with an independent context.
 * It cannot delegate further or interact directly with the owner.
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
  definition: SubAgentDefinitionSnapshot | null;
  /** 仅损坏记录的查询结果携带；执行拒绝使用空定义。 */
  definitionError?: string;
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
      snapshot: WorkspaceSnapshot;
    }
  | { kind: "direct"; path: string; dev: number; ino: number };

/** 读取已登记目标；缺失或损坏的基线明确拒绝，不转换为无目标工作。 */
export function parseWorkWriteTarget(json: string | null): WorkWriteTarget | null {
  if (json === null) return null;
  let v: WorkWriteTarget;
  try { v = JSON.parse(json) as WorkWriteTarget; }
  catch { throw new WorkspaceSnapshotError("target_corrupt"); }
  if (!v || typeof v !== "object" || typeof v.path !== "string" || !v.path.startsWith("/") || !Number.isSafeInteger(v.dev) || !Number.isSafeInteger(v.ino)) throw new WorkspaceSnapshotError("target_corrupt");
  if (v.kind === "direct") return v;
  if (v.kind === "worktree") {
    const snapshot = requireWorkspaceSnapshot(v.snapshot);
    if (v.repoRoot !== snapshot.source.path || v.commonGitDir !== snapshot.commonGit.path || v.baseCommit !== snapshot.head ||
        typeof v.gitdir !== "string" || !v.gitdir.startsWith("/") || typeof v.branch !== "string" || !v.branch) throw new WorkspaceSnapshotError("target_corrupt");
    return v;
  }
  throw new WorkspaceSnapshotError("target_corrupt");
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
  /** Owning user conversation. */
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
 *   messages for the Main Agent are injected through its result channel;
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
  /** Delivery task ID for a child; parent-context injection has no task. */
  deliveredTaskId: string | null;
  /** 投递登记时刻；null = 未投递。 */
  deliveredAt: string | null;
  /** 无法投递的明确结果（如 closed / moved_work / work_canceled）；null = 未判定。 */
  undeliveredReason: string | null;
}

/**
 * SubAgent 任务的限定资料范围（tasks.read_scope JSON）：
 * - paths：宿主钉定的只读路径（经 worker init 传入，模型参数不能替换）；
 *   每个路径保存规范化 realpath 与目录身份（dev/ino 供启动复核）。
 * - sourceRefs: source references selected by the Main Agent and reverified before use.
 */
export interface SubAgentReadScope {
  paths: Array<{ path: string; dev: number; ino: number; purpose: string }>;
  sourceRefs: unknown[];
  execution?: SubAgentExecutionSnapshot;
  workCopyHost?: WorkCopyHostSnapshot;
  readMemories?: string[];
}

/** Tool registration categories narrowed by host-bound conversation identity. */
export type ToolCategory = "coding" | "host_data" | "web_search" | "browser" | "desktop_browser" | "mcp" | "skills" | "subagent" | "workflow" | "owner_question" | "background_process";

export type ImageMimeType = "image/jpeg" | "image/png" | "image/webp";
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
  codeScheduleRunId?: string;
  codeScheduleActive?: boolean;
  id: string;
  name: string | null;
  branchSource: SessionBranchSource | null;
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
  queueRevision: number;
  /**
   * 拥有者存档时间（null = 未存档）。存档只把会话从工作区会话列表隐藏，
   * 不改资料身份、历史、任务归属或排队状态；设置页列出并可取消存档。
   */
  archivedAt: string | null;
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
  queueOrder: number;
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
  /** 父任务 id（编排器委派的子任务；null = 无父任务）。 */
  parentTaskId: string | null;
  /** 宿主派生任务登记时的发起任务权限版本；来源任务由 parentTaskId 关联。 */
  sourcePermissionVersion: number | null;
  /** 截止时间（ISO；超时由编排器取消；null = 无期限）。 */
  deadline: string | null;
  /** 结构化结果摘要（终态后由编排器记录，一次写入；null = 尚未记录）。 */
  resultSummary: string | null;
  /** 结果引用（JSON：完整结果的查询位置，如 {"sessionId","taskId"}）。 */
  resultRef: string | null;
  /** The delegated work and child execution identity, when present. */
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

export interface TaskGuidance {
  sourceTaskId: string;
  targetTaskId: string;
  sessionId: string;
  acceptedSeq: number;
  state: "pending" | "joined" | "fallback" | "canceled";
  entryId: string | null;
}

/** Persistent phases of a message recall request. */
export type MessageRecallPhase =
  /** Intent accepted, awaiting adjudication. */
  | "accepted"
  /** Stopping the entire execution closure. */
  | "stopping"
  /** Stop or closure ownership remains unverified; verify-only may advance the request. */
  | "blocked"
  /** Stop verified; applying JSONL omissions. */
  | "applying"
  /** Completed: the sole basis for draft restoration eligibility. */
  | "completed"
  /** Rejected during preflight or progression; terminal receipt. */
  | "rejected";

/**
 * A recall request fixes one owner-input target. State and events commit transactionally;
 * the target, original text and attachments are fixed at acceptance rather than reread later.
 */
export type MessageRecallPurpose = "queued" | "historical";

export interface MessageRecall {
  id: string;
  purpose: MessageRecallPurpose;
  sessionId: string;
  /** Client idempotency key, unique within the conversation. */
  requestId: string;
  /** Parameter digest; reject changed parameters under the same key. */
  paramsDigest: string;
  /** Source Task of the recalled input. */
  targetTaskId: string;
  /** Source input admission sequence fixed when the request is accepted. */
  inputSeq: number;
  /** Queue revision for retrieval, or input admission sequence for historical recall. */
  expectedRevision: number;
  /** Execution task to stop and verify: the guidance target or source Task itself. */
  execTaskId: string | null;
  phase: MessageRecallPhase;
  /** Fixed stopping closure: the execution task and its trusted derived tasks. */
  stopTaskIds: string[];
  /** Source barrier permanently preventing new derived work, delivery and consumption from these tasks. */
  sealedTaskIds: string[];
  /** JSONL omission IDs fixed after stop verification, or null before being fixed. */
  omittedEntryIds: string[] | null;
  /** History prefix identity and fingerprint when fixing the omission list. */
  historyFingerprint: { dev: number; ino: number; byteLimit: number; fingerprint: string } | null;
  /** Original target input, the sole source of restored draft text. */
  originalInput: string;
  /** Original attachment metadata; rebinding uses only immutable original bytes. */
  originalAttachments: AttachmentMetadata[];
  /** Fresh attachments rebuilt from original bytes, lazily persisted for idempotent request replay. */
  draftAttachments: AttachmentMetadata[] | null;
  /** Monotonically increasing completion revision within the conversation. */
  completionRevision: number | null;
  /** Next recall candidate computed at completion. */
  nextCandidateTaskId: string | null;
  /** Whether this completed request still owns draft installation. */
  editOpen: boolean;
  /** Historical recall saves dispatch state until its edit window closes; retrieval leaves this null. */
  savedQueueState: "active" | "paused" | null;
  savedQueueReason: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Redacted event, snapshot and query view. Draft text and staged attachments are returned only by
 * message_recall_state with the original request key; broadcasts omit them because the key identifies the initiating client.
 */
export type PublicMessageRecall = Omit<MessageRecall, "originalInput" | "originalAttachments" | "draftAttachments">;

export interface TaskQueue {
  revision: number;
  tasks: Array<{ taskId: string; queueOrder: number }>;
  retrievableTaskIds: string[];
}

/** 审批展示的权限范围（结构化、可验证；凭据只出现名称与用途，不含原值）。 */
export type ApprovalScope =
  | { kind: "tool"; workspaceOnly: boolean }
  | { kind: "browser_operation"; sessionId: string; generation: string | null; action: string; targetId: string | null }
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
      endpoint?: string;
      cua?: { kind: string; executable: string; sha256: string };
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
  /** Final approval decision source. */
  decisionSource: "owner" | "auto_review" | null;
}

/** 工具执行依据；完全访问与单次批准分别留存，不伪造拥有者决定。 */
export type ToolAuthorization =
  | { source: "full_access"; taskId: string; permissionVersion: number; scope: ApprovalScope }
  | { source: "approval"; taskId: string; permissionVersion: number; confirmationId: string; scope: ApprovalScope };

export interface McpCuaOperation {
  serviceId: string;
  configVersion: number;
  configuration?: { kind: "cua-mac"; executable: string; version: "0.38.0"; sha256: string };
  effect: "read" | "write" | "unknown";
  rawTool: { name: string; inputSchema: Record<string, unknown> };
  modelTool: { name: string; inputSchema: Record<string, unknown> };
  arguments: Record<string, unknown>;
  execution: { executionId: string; fingerprint: string; directory: string };
  state: "starting" | "prepared" | "not_sent" | "sent" | "finished" | "frozen" | "recovering" | "recovered" | "closed";
  request?: string;
  response?: string;
  stoppedAt?: string;
  ownerStartedAt?: string;
  recoversOpId?: string;
  observationOpId?: string;
  observationArtifactIds?: string[];
  acceptedAt?: string;
}

/** 普通 MCP 只保存操作证据，不持有电脑执行身份。 */
export interface McpHttpOperation {
  recordVersion: 2;
  transport: "http";
  serviceId: string;
  configVersion: number;
  remoteName: string;
  effect: "read" | "write" | "unknown";
  state: "prepared" | "not_sent" | "sent" | "finished" | "frozen";
  started: boolean;
  remoteEnded: boolean;
  remoteRejected?: boolean;
  resultArtifactId?: string;
  isError?: boolean;
  error?: { code: number; message: string; data?: unknown };
  execution?: never;
  configuration?: never;
  request?: never;
  response?: never;
}
export type McpOperation = McpCuaOperation | McpHttpOperation;

export interface ToolOp {
  mcp?: McpOperation;
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
  /** MIME 仅图片使用；用户附件与图片的 SHA-256 固定原字节，旧工具正文为空。 */
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
  | { type: "code_schedule.changed"; plan: import("./code-scheduler.ts").CodeSchedulePlan }
  | { type: "code_schedule.run_changed"; run: import("./code-scheduler.ts").CodeScheduleRun }
  | { type: "code_schedule.task_bound"; taskId: string; runId: string; sessionId: string }
  | { type: "background_process.changed"; process: import("./background-processes.ts").BackgroundProcessView }
  | { type: "background_process.closed"; closure: import("./background-processes.ts").BackgroundClosure }
  | { type: "owner_question.changed"; question: import("./owner-questions.ts").OwnerQuestionView }
  | { type: "task.memory_accessed"; taskId: string; sessionId: string; memoryId: string }
  | { type: "agent_wait.changed"; waitId: string; taskId: string; phase: import("./agent-wait.ts").AgentWaitPhase; reason: string | null; wait: import("./agent-wait.ts").AgentWaitView }
  | { type: "task.resources_changed"; taskId: string; sessionId: string; phase: "execution" | "conversation" }
  | { type: "agent_report.changed"; key: string; taskId: string | null; status: import("./agent-wait.ts").AgentReport["status"]; reason: string | null; fallbackTaskId: string | null; fallbackState: import("./agent-wait.ts").AgentReport["fallbackState"]; parkedFallbackTaskIds: string[] }
  | { type: "workflow.definition"; name: string; definitionId: string; digest: string }
  | { type: "workflow.changed"; runId: string; version: number; status: import("./workflow.ts").WorkflowRun["status"]; reason: string | null }
  | { type: "workflow.step"; runId: string; key: string; status: import("./workflow.ts").WorkflowStep["status"]; delivery: number | null }
  | { type: "workflow.execution"; runId: string; taskId: string; kind: "agent" | "host"; status: "queued" | "running" | "finished"; stopVerified: boolean | null }
  /** 模型配置已在线应用（issue 21 §4）：载荷不含任何秘密，供前端刷新配置视图。 */
  | { type: "model.config_changed"; kind: "catalog" | "api_key" | "default_model" | "summary_model"; provider?: string }
  | { type: "project.created"; projectId: string; name: string; createRequestId: string | null; rootDir?: DirIdentity | null; managed?: boolean }
  | { type: "project.jev_changed"; projectId: string; configVersion: number; enabled: boolean }
  /**
   * 项目指令列表已保存（agent-direction issue 06）：携带设置版本与可供视图
   * 更新的配置字段；不含指令正文或秘密。冲突的保存不产生本事件。
   */
  | { type: "project.settings_changed"; projectId: string; settingsVersion: number; instructionFiles: string[] }
  /**
   * 实例级 Web Search 开关已保存：全实例共用一个开关，携带版本与状态；
   * 同值保存幂等，不产生本事件。
   */
  | { type: "web_search.changed"; version: number; state: "enabled" | "disabled" }
  | { type: "session.created"; sessionId: string; projectId: string; kind: SessionKind; cwd: string; modelSelection: ModelSelection | null; modelSelectionVersion: number; createRequestId: string | null; session?: Session }
  /** 侧聊绑定已发布（coding-side-chat）：与侧聊会话的 session.created 同一事务；普通列表按此排除。 */
  | { type: "side_chat.bound"; parentSessionId: string; sideSessionId: string }
  | { type: "session.model_selection_changed"; sessionId: string; modelSelection: ModelSelection; modelSelectionVersion: number }
  | { type: "session.default_mode_changed"; sessionId: string; defaultAccessMode: SessionDefaultMode; defaultAccessModeVersion: number }
  /** 拥有者存档状态变化：仅影响列表可见性，任务与历史不受影响。 */
  | { type: "session.archive_changed"; sessionId: string; archivedAt: string | null }
  | { type: "session.context_compaction"; sessionId: string; requestId: string; status: SessionCompactionRequest["status"] }
  | { type: "task.attachments"; taskId: string; sessionId: string; attachments: AttachmentReference[] }
  | { type: "task.queued"; inputPurpose?: import("./views.ts").InputPurpose; taskId: string; sessionId: string; requestId: string; accessMode: AccessMode; parentTaskId?: string | null; sourcePermissionVersion?: number | null; planMode: boolean; modelSelection: ModelSelection | null; queueOrder: number }
  | { type: "task.started"; taskId: string; sessionId: string }
  | { type: "session.queue_changed"; sessionId: string; queue: TaskQueue }
  | { type: "task.guidance"; taskId: string; sessionId: string; guidance: TaskGuidance }
  | { type: "message_recall.changed"; sessionId: string; recall: PublicMessageRecall }
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
  | { type: "task.confirmation_resolved"; taskId: string; confirmationId: string; decision: "approved" | "rejected"; source?: "owner" | "auto_review"; reason?: string }
  /** 自动审查转人工（issue 15）：审批仍 pending，等待拥有者决定。 */
  | { type: "task.confirmation_reviewed"; taskId: string; confirmationId: string; decision: "ask_owner"; reason: string }
  | { type: "task.approval_consumed"; taskId: string; confirmationId: string; toolOpId: string; toolName: string }
  | { type: "task.tool_authorized"; taskId: string; toolOpId: string; authorization: ToolAuthorization }
  | { type: "browser.binding_changed"; sessionId: string; generation: string; state: string; kind: "owned" | "attached"; failureCode: string | null }
  | { type: "task.mode_switch_requested"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode }
  | { type: "task.mode_switched"; taskId: string; sessionId: string; from: AccessMode; to: AccessMode; permissionVersion: number }
  | { type: "task.mode_switch_failed"; taskId: string; sessionId: string; to: AccessMode; reason: string }
  /** 桌面浏览器接管等待边界：waiting 翻转仅作投影事实，任务保持 running。 */
  | { type: "task.browser_wait"; taskId: string; sessionId: string; waiting: boolean }
  /**
   * 运行中输出：contentIndex 是后台分配的连续正文段序号（不等同 SDK
   * 块索引，部分 provider 在思考/正文交错时复用 SDK 索引）。offset/totalBytes
   * 是该段的 UTF-8 字节偏移/累计大小；无 contentIndex 时作用于整条消息。
   * 无 offset 的旧事件为累计文本尾部。startedAt 是该段首次实际正文时间。
   * message_end 会冲刷所有段；最终消息以 output_entry 关联的 JSONL 为准。
   */
  | { type: "task.output_fragment"; taskId: string; sessionId: string; messageId: string; text: string; totalBytes: number; truncated: boolean; partial: true; offset?: number; startedAt?: string; contentIndex?: number }
  | { type: "task.thinking"; taskId: string; sessionId: string; thinkingId: string; messageId: string; startedAt: string; endedAt: string | null; text: string; offset?: number }
  | { type: "task.output_entry"; inputPurpose?: import("./views.ts").InputPurpose; taskId: string; sessionId: string; entryId: string; sessionFile: string; role: string; messageId: string | null }
  /**
   * 工具/审批事件（线上载荷）：params 可能被替换为有界预览
   * （paramsTruncated=true，paramsBytes 为完整序列化字节数）；完整参数经
   * get_confirmation_params / get_tool_op_params 按 ID 分段读取。持久化的事件正文保持完整。
   */
  | { type: "task.tool_intent"; taskId: string; toolOpId: string; sdkCallId: string | null; toolName: string; params: Record<string, unknown>; paramsBytes?: number; paramsTruncated?: boolean }
  | { type: "task.tool_result"; taskId: string; toolOpId: string; summary: string; isError: boolean; artifactIds: string[]; editStats?: EditStats }
  | { type: "task.mcp_operation_changed"; taskId: string; toolOpId: string; state: McpOperation["state"] }
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
  | { type: "mcp.service_changed"; serviceId: string; name: string; endpoint?: string; cua?: { kind: string }; configVersion: number; action: "upsert" | "enabled" | "disabled" | "removed" }
  /** 任务开始时显式启用的服务初始化失败（连接/认证/超时等）：本任务缺少其工具能力。 */
  | { type: "mcp.service_unavailable"; serviceId: string; taskId: string; sessionId: string; name: string; endpoint?: string; cua?: { kind: string }; reason: string }
  | { type: "backend.started"; dataDir: string; executionBackend: string; product: string }
  | { type: "backend.stopping"; reason: string }
  | { type: "backend.stopped"; reason: string }
  | { type: "backend.recovered"; interruptedTaskIds: string[]; pausedSessionIds: string[] }
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
  /** Work messages enter a child task, wake a scheduled parent, await parent injection, or remain pending. */
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
  | { type: "work_delegation.integrated"; workId: string; parentSessionId: string; subAgentId: string; taskId: string; branch: string; baseCommit: string; parentHead: string | null; files: string[]; filesChanged: number; insertions: number; deletions: number; patchBytes: number };

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
