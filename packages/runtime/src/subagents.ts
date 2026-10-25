/**
 * 通用 SubAgent 委派（agent-direction issue 11；issue 12 继续/复用/
 * 关闭；issue 14 整项取消；issue 16 修改委派——worktree 隔离与非 Git 串行；
 * issue 17 改动汇总并开放 main 的修改委派；issue 19 宿主固定评审）：
 * 集中登记工作委托、动态 SubAgent 身份与每次执行任务。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md
 * Note: 见 .agents/notes/implemented/feature/2026-10-12-full-access-current-account.md
 *
 * 边界：
 * - 来源能力与角色要求在登记前预检并保存，模型只给工作、角色和明确资料；
 *   身份、目录、有效模式与截止时间由宿主固定，不继承单次批准或长期授权；
 * - 每项首派同事务建立工作/Agent/独立会话/排队任务并记审计事件；提交后才
 *   kick 子会话。准备（模型门闩、受限执行入口预检、目录与资料快照、路径核实）
 *   在事务外完成；准备或落库失败只清理本次新建的目录或本次写入的快照文件，
 *   竞争请求已用的目录不动；
 * - 幂等：首次委派与复用委派以（父会话, 键）查工作；工作内以（会话,
 *   sdelegate:<workId>:<key>）查任务。参数摘要不包含本次调用的父任务 id 与
 *   模型选择，跨对话轮次重放返回首次记录；同键异参明确冲突，不另建执行；
 * - 继续（workId）与复用（subAgentId）都要求目标 Agent 可用：同一父会话、
 *   未关闭、空闲且无活动任务、工作目录身份与记录一致；忙碌明确拒绝不排队；
 * - 关闭（issue 12）是独立列（closed_at/closed_by），不改 state：有活动任务
 *   拒绝关闭；已关闭幂等返回；关闭后拒绝新委派，历史/产物/目录保留；
 * - 整项取消（issue 14）用独立列（canceled_at/canceled_by/cancel_reason），
 *   一次写入：登记事务内把本工作的排队任务直接转为 canceled、活动任务写
 *   取消意图，提交后按现有停止路径逐个处理；登记事务与委派登记天然串行，
 *   先登记的任务必然在取消清单内，后登记的必然被拒；已取消幂等返回；
 *   取消不关闭 SubAgent、不删除历史/产物/工作目录，迟到结果保存为事实但
 *   不再送达父模型；
 * - 资料与路径：main 的资料在委派时经 SourceResolver 解析为文本快照写入子工作
 *   目录（来源引用保存在任务 read_scope，启动与每次发送上下文前按该 Agent 全部
 *   历史任务的并集重新 verify）；dev 的待读路径限于父工作区及父任务已授予范围
 *   （取交集只读），保存 realpath 与目录身份，路径经宿主钉定传入 worker。
 * - 宿主固定评审（issue 19）：仅编排器经 hostReview 入参调用（工具层不会
 *   产生）：每个入站修订登记一项新工作、一个新 SubAgent，跳过拥有者委派名额，
 *   任务带来源事件以复用出队门与通知回写；评审 SubAgent 空闲后保留但不参与
 *   继续/复用（assertAvailable 按来源事件拒绝）。
 * ponytail: 评审并行运行、无并发名额；模型成本成为问题时给宿主评审加并发上限。
 * - 工作内协作消息（agent-direction issue 13）：同项工作的参与者（主 Agent
 *   与当前承接本工作的各 SubAgent）经 subagent_message 交换有来源的消息。
 *   协作加入：work_id 与 sub_agent_id 同现 = 把一个既有空闲 SubAgent 拉入
 *   既有工作登记一次执行任务（修改工作单一写入者、宿主评审固定流程均拒绝）。
 *   消息按（工作, 发送方, 键）幂等；发给 SubAgent 的投递为本工作的一次执行
 *   任务（请求键 smsg:<消息ID>），接收方正忙/名额满待投递，宿主机在任务终态、
 *   启动、取消与关闭时冲刷；资格已失（转做其他工作、已关闭）或工作已取消记
 *   明确未投递结果。发给主 Agent 的由父级送达（parent-delivery.ts）定方向：
 *   dev 注入或 main 消息唤醒。消息只携带正文与来源，不扩大接收方的工具与资料范围。
 */

import { assertGrantNotProtected } from "@ruukoto/agent/execution/approved-ops.ts";
import type { WorkerLauncher } from "@ruukoto/agent/execution/launchers.ts";
import { subAgentTaskRequestId } from "@ruukoto/agent/subagent-ledger.ts";
import { HOST_REVIEW_DEFINITION, SubAgentRoleError, validateSubAgentRole, type SubAgentRoleLibrary } from "@ruukoto/agent/subagent-roles.ts";
import { requireSubAgentDefinition, SubAgentDefinitionError } from "@ruukoto/core/subagent-definition.ts";
import type { SubAgentDefinitionSnapshot } from "@ruukoto/core/subagent-definition.ts";
import { requireSubAgentExecutionScope, snapshotSubAgentExecution, SubAgentExecutionError, type SubAgentExecutionSnapshot } from "@ruukoto/core/subagent-execution.ts";
import { WorkspaceSnapshotError } from "@ruukoto/core/workspace-snapshot.ts";
import type { WorkflowSource } from "@ruukoto/core/workflow.ts";
import { subAgentAccessPolicy } from "@ruukoto/agent/subagent-capabilities.ts";
import type { SourceRef } from "@ruukoto/channels/scheduler/store.ts";
import type { SourceResolver } from "@ruukoto/channels/source-resolver.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { CodeScheduleError, bindCodeScheduleTask, getCodeScheduleRunForTask, getCodeScheduledTaskSource } from "@ruukoto/core/code-scheduler.ts";
import type {
  AccessMode,
  ModelSelection,
  Session,
  SubAgent,
  SubAgentClosedBy,
  SubAgentMessage,
  SubAgentReadScope,
  Task,
  WorkCanceledBy,
  WorkDelegation,
  WorkWriteTarget,
} from "@ruukoto/core/types.ts";
import { randomId } from "@ruukoto/core/types.ts";
import { grantCoversPath } from "@ruukoto/core/worktree.ts";
import type { ParentDelivery } from "@ruukoto/runtime/parent-delivery.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { INTEGRATE_FILE_LIST_CAP,WorkCopyError,WorkCopyManager } from "./work-copy.ts";
import { selectSubAgentRole } from "./subagent-role-library.ts";

/** 委派正文上限（登记时拒绝，超出不入库）。 */
const INPUT_TEXT_CAP = 8192;
/** 工作内消息正文上限（issue 13；登记时拒绝——含来源说明后的投递输入总在委派上限内）。 */
const MESSAGE_TEXT_CAP = 4096;
/** 委派上限与任务时限：同一父用户会话的活动 SubAgent 执行任务数。 */
export const SUBAGENT_LIMITS = { perParentSession: 3, deadlineMs: 60 * 60_000 };
/**
 * 快照文件名（子工作目录内；按工作 + 执行键命名——复用同一 Agent 承接新工作
 * 时不覆写旧工作的快照；目录与文件名由宿主生成，key 字符集已经过 KEY_RE 校验）。
 */
function materialsFileFor(workId: string, key: string): string {
  return `materials-${workId}-${key}.txt`;
}

/**
 * SubAgent 任务的提交摘要：覆盖逻辑参数与任务身份（工作、Agent、参数摘要），
 * 不含本次调用的父任务 id、模型选择与截止时间——跨轮次重放核实同一逻辑委派。
 */
export function taskSubmissionDigest(workId: string, subAgentId: string, paramsDigest: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind: "sdelegate", paramsDigest, workId, subAgentId }))
    .digest("hex");
}

export interface SubAgentDelegateInput {
  /** 实际发起委派的任务（直接父任务；摘要不覆盖它，跨轮次重放不误冲突）。 */
  parentTaskId: string;
  key: string;
  request: string;
  /** 既有工作（沿原工作追加任务）；null = 新工作。 */
  workId?: string | null;
  /**
   * 复用既有空闲 SubAgent 承接新工作（issue 12）；与 workId 同现 = 协作加入
   * （issue 13）：把该空闲 Agent 拉入既有工作登记一次执行任务（任务关联列指向
   * 协作方，工作行保持首次承接者；修改工作与宿主评审工作不接受协作加入）。
   * 两种情况都保留该 Agent 的独立会话上下文；读范围与资料按本次任务重新钉定。
   */
  subAgentId?: string | null;
  /** 首次缺省 general；继续和复用省略时沿已固定角色。 */
  role?: string;
  /** 委派代码目标（相对父工作区或可解析到父工作区内的路径）；不配资料或读范围。 */
  target?: string | null;
  /** main 选定资料（原样引用对象；重复委派不重新解析）。 */
  materials?: Record<string, unknown>[] | null;
  /** dev 待读取路径（宿主核实交集后钉定只读范围）。 */
  readPaths?: string[] | null;
  /** 工具计算的规范化参数摘要，覆盖正文、角色、工作、SubAgent、目标与资料参数。 */
  paramsDigest: string;
  /**
   * 宿主固定评审（agent-direction issue 19）：仅编排器经 OrchestratorDeps 传入，
   * 不来自任何模型工具参数。宿主为入站事件固定每次委派一个新 SubAgent：跳过
   * 委派名额（计数按来源事件排除，见 store），任务带来源事件键，输入走评审
   * 首行；不配资料/读路径/写入目标，读范围为空，工单详见 GitHubEvents。
   */
  hostReview?: { sourceEventId: string } | null;
}

export interface SubAgentDelegation {
  work: WorkDelegation;
  agent: SubAgent;
  task: Task;
  /** true = 本次登记了新任务；false = 同键同参复核命中既有记录。 */
  created: boolean;
  /** true = 本次新建了工作（省略 workId：首次委派或复用承接新工作）。 */
  newWork: boolean;
}

/** 整项取消（issue 14）的结果：登记后的工作记录与本工作的全部执行任务（停止完成后重读）。 */
export interface WorkCancellation {
  work: WorkDelegation;
  /** true = 此前已取消，幂等返回原记录（本次不产生事件、不动任务）。 */
  alreadyCanceled: boolean;
  tasks: Task[];
}

/** 工作内协作消息的发送入参（issue 13；发送方身份完全由发起任务核实，不接受调用方指定）。 */
export interface SubAgentMessageInput {
  /** 发起任务（SubAgent 任务或工作父会话的任务；发送方 = 该任务所属身份）。 */
  senderTaskId: string;
  workId: string;
  /** 发送方幂等键（按（工作, 发送方, 键）查重；同键同参返回原记录，异参冲突）。 */
  key: string;
  text: string;
  /** 接收的 SubAgent；省略/null = 主 Agent。主 Agent 发送时必须指定。 */
  toSubAgentId?: string | null;
  /** 规范化参数摘要（覆盖 work_id/to_sub_agent_id/key/text）。 */
  paramsDigest: string;
}

export interface SubAgentMessageResult {
  message: SubAgentMessage;
  /** true = 本次登记了新消息；false = 同键同参命中原记录。 */
  created: boolean;
  /** 本次登记的投递判定；同键重放为 null（按行现状字段解读）。 */
  delivery: "task" | "wake" | "inject" | "pending" | null;
}

export interface SubAgentManagerDeps {
  store: Store;
  roles(): SubAgentRoleLibrary;
  source?(taskId: string): WorkflowSource;
  verifySource?(source: WorkflowSource): boolean;
  preflight?(source: WorkflowSource, definition: SubAgentDefinitionSnapshot): Promise<SubAgentExecutionSnapshot>;
  /** 子工作目录根（保护根之外，如 agent-work/sub-agents/）。 */
  workRoot: string;
  /** 工作副本模块：负责副本创建、复核和汇总；本管理器只登记归属与事件。 */
  workCopies: WorkCopyManager;
  /** main 资料的解析与授权复核（重复委派不重新解析；verify 在发送前复核）。 */
  sources: SourceResolver;
  /** 模型配置门闩检查闭包（runOuter 预检、事务内重检）。 */
  resolveSelection(selection: ModelSelection): Promise<() => void>;
  launcherFor(mode: AccessMode): WorkerLauncher;
  defaultModelSelection(): ModelSelection;
  kickSession(sessionId: string): void;
  /** 通用队列与占用仍由 Runtime 管理；这里只恢复安全的重启暂停。 */
  resumeQueue(sessionId: string): Promise<unknown>;
  /** 父级送达（架构工单 09）：发给主 Agent 的消息在消息事务内交给它定送达方向。 */
  parentDelivery: Pick<ParentDelivery, "messageRecorded">;
  /** 停止单个执行任务（Runtime 接线；整项取消的登记事务提交后逐一调用）。 */
  cancelTask(taskId: string, reason?: string): Promise<Task>;
  protectedRoots(): string[];
  /** 后台数据目录（拒绝把工作目录放进保护根）。 */
  dataDir: string;
}

/**
 * 改动汇总（agent-direction issue 17）的结果：state 区分四种结论——
 * applied=差异已套用到父工作区待检查；already=完整差异已在工作区（幂等命中，
 * 不重复写入、不重复登记）；empty=副本与基线无差异；direct=直接写入工作本就
 * 没有副本需要汇总。统计与文件清单来自汇总时的完整差异（numstat）。
 */
export interface WorkIntegration {
  work: WorkDelegation;
  state: "applied" | "already" | "empty" | "direct";
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
  /** worktree 工作的来源基线提交；其他状态为 null。 */
  baseCommit: string | null;
  /** 汇总时刻父仓库 HEAD（读取失败为 null）。 */
  parentHead: string | null;
}

export class SubAgentDelegationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SubAgentManager {
  private readonly deps: SubAgentManagerDeps;
  private readonly workCopies: WorkCopyManager;

  constructor(deps: SubAgentManagerDeps) {
    this.deps = deps;
    this.workCopies = deps.workCopies;
  }

  private get store(): Store {
    return this.deps.store;
  }

  verifyWorkspace(work: WorkDelegation): void {
    if (work.writeTarget?.kind === "worktree") this.workCopies.assertCopy(work, work.writeTarget, "保留副本并核实工作区基线");
  }

  /** 结果事务内调用：历史补记不能倒写后来执行的工作与任务指针。 */
  resultRecorded(task: Task): void {
    const agent = task.subAgentId ? this.store.getSubAgent(task.subAgentId) : null;
    if (!agent || agent.sessionId !== task.sessionId || agent.currentTaskId !== task.id) return;
    const held = this.store.listAllOccupancy().some((o) => o.sessionId === agent.sessionId);
    this.store.setSubAgentState(agent.id, held ? "unverified" : "idle", {
      activeWorkId: task.workId, currentTaskId: null,
    });
  }

  /** 恢复事务内调用：普通委派中断；宿主评审及开放调度运行保留原排队任务。 */
  recoverQueuedTasks(): string[] {
    const ids: string[] = [];
    for (const task of this.store.listQueuedSubAgentTasks()) {
      const scheduled = this.store.getScheduledRunForTask(task.id);
      const codeScheduled = getCodeScheduleRunForTask(this.store, task.id);
      if (scheduled && !scheduled.closedAt && scheduled.scheduleStatus !== "canceled" || codeScheduled && !codeScheduled.closedAt && !codeScheduled.cancelRequested) continue;
      if (!this.store.endTask(task.id, ["queued"], "interrupted", {
        interruptReason: "backend_restart", endedAt: new Date().toISOString(),
        keepOccupancy: true,
      })) continue;
      ids.push(task.id);
    }
    return ids;
  }

  /** 拥有者核实事务内调用；返回需要在提交后冲刷消息的父会话。 */
  executionVerified(sessionId: string): string | null {
    const agent = this.store.getSubAgentBySession(sessionId);
    if (!agent || this.store.findActiveSubAgentTask(agent.id)) return null;
    const current = agent.currentTaskId ? this.store.getTask(agent.currentTaskId) : null;
    if (current && current.resultSummary === null) {
      throw new SubAgentDelegationError("invalid_state", `SubAgent 任务 ${current.id} 的结果尚未登记：请先完成结果补记再恢复`);
    }
    if (this.store.listAllOccupancy().some((o) => o.sessionId === sessionId)) return null;
    if (agent.state === "unverified" || agent.state === "running") {
      this.store.setSubAgentState(agent.id, "idle", { currentTaskId: null });
    }
    return agent.parentSessionId;
  }

  /** 结果补记完成后启动：冲刷消息，只自动恢复没有遗留占用的重启暂停。 */
  async start(): Promise<void> {
    await this.flushPendingMessages();
    for (const agent of this.store.listSubAgents()) {
      const session = this.store.getSession(agent.sessionId);
      if (session?.queueState !== "paused" || session.queuePauseReason !== "backend_restart") continue;
      if (this.store.listAllOccupancy().some((o) => o.sessionId === agent.sessionId)) continue;
      const task = this.store.findActiveSubAgentTask(agent.id);
      if (task && getCodeScheduleRunForTask(this.store, task.id)) continue;
      const scheduled = task ? this.store.getScheduledRunForTask(task.id) : null;
      if (scheduled && !this.store.scheduledRunCanResume(scheduled.id)) continue;
      try { await this.deps.resumeQueue(agent.sessionId); }
      catch (err) { this.log(`恢复 SubAgent ${agent.id} 队列失败：${(err as Error).message}`); }
    }
  }

  private log(message: string): void {
    process.stderr.write(`[ruukoto:subagents] ${message}\n`);
  }

  /** 授权登记前后核实发起任务；宿主评审允许已完成的接收轮次，来源仍固定 GitHub。 */
  private assertSource(task: Task, snapshot: Task = task, hostReview?: SubAgentDelegateInput["hostReview"]): void {
    getCodeScheduledTaskSource(this.store, task.id);
    const scheduled = this.store.getScheduledRunForTask(task.id);
    if (scheduled && (scheduled.closedAt || scheduled.scheduleStatus === "canceled")) {
      throw new SubAgentDelegationError("task_ending", "调度运行已结束或计划已取消，拒绝登记新的委派或消息");
    }
    const reviewEvent = hostReview ? this.store.getInboundEvent(hostReview.sourceEventId) : null;
    const hostAccepted = hostReview && reviewEvent?.source === "github" && task.sourceEventId === reviewEvent.id &&
      task.accessMode === "confirm" && task.status === "completed";
    if ((!hostAccepted && !["queued", "running", "awaiting_confirmation"].includes(task.status)) || task.cancelRequested ||
        task.permissionVersion !== snapshot.permissionVersion || task.accessMode !== snapshot.accessMode) {
      throw new SubAgentDelegationError("task_ending", "发起任务已结束或权限已变化，拒绝登记新的委派或消息");
    }
    if (hostReview && (!reviewEvent || reviewEvent.source !== "github" || !["registered", "queued"].includes(reviewEvent.status) || task.sourceEventId !== reviewEvent.id || task.accessMode !== "confirm")) {
      throw new SubAgentDelegationError("forbidden", "宿主评审来源或固定模式不符，拒绝登记");
    }
  }

  /**
   * 非阻塞委派：登记后立即返回。查重先于资料解析与限额；新请求先异步准备
   * 再在一个同步事务内重核并登记，提交后 kick 子会话。
   */
  async delegate(input: SubAgentDelegateInput): Promise<SubAgentDelegation> {
    if ("mode" in input) throw new SubAgentDelegationError("interface_upgrade_required", "mode 委派接口已移除：用 role 选择职责、target 指定代码目标；冻结验证用工作流 agent 的 verify。请更新调用后以原 key 核实，勿换键重放旧工作");
    const parent = this.store.getTask(input.parentTaskId);
    if (!parent) throw new SubAgentDelegationError("not_found", `父任务不存在：${input.parentTaskId}`);
    const parentSession = this.store.getSession(parent.sessionId);
    if (!parentSession) throw new SubAgentDelegationError("not_found", `父任务会话不存在：${parent.sessionId}`);
    // 父会话按身份判定（架构工单 08）：普通开发、main 与独立调度会话可以委派
    const parentKind = this.store.getSessionIdentity(parent.sessionId)?.kind;
    if (parentKind === "subagent") throw new SubAgentDelegationError("forbidden", "SubAgent 不能委派下级（只有普通开发、main 或独立调度会话可以登记工作委托）");
    if (parentKind !== "dev" && parentKind !== "main" && parentKind !== "scheduled") throw new SubAgentDelegationError("forbidden", "只有普通开发、main 或独立调度会话可以登记工作委托（已退役归档会话不能委派）");
    if (!input.request.trim()) throw new SubAgentDelegationError("invalid_params", "委派正文不能为空");
    if (input.role !== undefined && (typeof input.role !== "string" || !input.role.trim())) throw new SubAgentDelegationError("invalid_params", "角色名不能为空");
    if (parent.planMode &&
        (input.target != null || (input.workId && this.store.getWorkDelegation(input.workId)?.writeTarget))) {
      throw new SubAgentDelegationError("forbidden", "计划模式不能发起修改委派或继续修改工作");
    }
    if (input.workId && input.target != null) {
      throw new SubAgentDelegationError("invalid_params", "继续委派沿原目标，不能重新指定 target；请新建工作");
    }
    if (
      input.hostReview &&
      (input.role !== undefined || input.workId || input.subAgentId || input.target != null || (input.materials?.length ?? 0) > 0 || (input.readPaths?.length ?? 0) > 0)
    ) {
      throw new SubAgentDelegationError("invalid_params", "宿主评审不携带复用/修改/资料参数（每个入站修订一项新工作、一个新 SubAgent）");
    }

    // —— 查重先：重复委派不重新解析可能已变化的资料（同键同参的重放即使目标
    // Agent 已关闭或忙碌也返回原记录，不新建任务）——
    const hit = input.workId ? this.dedupWorkTask(input, parentSession) : this.dedupNewKey(input, parentSession);
    if (hit) return hit;
    this.assertSource(parent, parent, input.hostReview);

    // —— 目标 Agent：继续沿工作的 Agent；复用按 subAgentId；两者都省略即新建 ——
    const reusedWork = input.workId ? this.store.getWorkDelegation(input.workId) : null;
    if (input.workId && !reusedWork) {
      throw new SubAgentDelegationError("not_found", `工作委托不存在或不属于本会话：${input.workId}`);
    }
    if (reusedWork && reusedWork.parentSessionId !== parentSession.id) {
      throw new SubAgentDelegationError("forbidden", "该工作委托不属于本会话");
    }
    // 已取消的工作拒绝继续委派（准备前一次；登记事务内再核一次，见下）
    if (reusedWork?.canceledAt) {
      throw new SubAgentDelegationError("invalid_state", `工作已取消（${reusedWork.canceledAt}）：不能继续委派`);
    }
    let target = reusedWork ? this.store.getSubAgent(reusedWork.subAgentId) : null;
    if (reusedWork && !target) throw new SubAgentDelegationError("not_found", `工作 ${reusedWork.id} 缺少 SubAgent 记录`);
    if (input.subAgentId) {
      target = this.store.getSubAgent(input.subAgentId);
      if (!target) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${input.subAgentId}`);
    }
    // 继续与复用都要求可用（准备前一次；登记事务内再核一次）。
    // 继续（workId）复核工作原有写入目标；复用（subAgentId）承接新工作
    // 会为本次另建写入目标（不与旧工作的现场污染守门纠缠），不复核旧目标。
    if (target) {
      this.assertAvailable(target, parentSession, reusedWork);
      this.assertRole(target, input.role);
    }
    const definition = target ? validateSubAgentRole(requireSubAgentDefinition(target))
      : input.hostReview ? HOST_REVIEW_DEFINITION : selectSubAgentRole(this.deps.roles(), input.role ?? "general");
    const policy = subAgentAccessPolicy(parent.accessMode, definition);
    const source = input.hostReview ? undefined : this.deps.source?.(parent.id);
    const execution = source && !input.hostReview ? await this.deps.preflight?.(source, definition) : undefined;
    // 协作加入（issue 13，workId 与 subAgentId 同现且不是工作原 Agent）：只读
    // 工作才接受新协作方（修改工作同一份文件单一写入者）；宿主评审是固定单
    // Agent 流程，不接受协作加入。
    if (reusedWork && target && target.id !== reusedWork.subAgentId) {
      if (reusedWork.writeTarget) {
        throw new SubAgentDelegationError("invalid_state", `工作 ${reusedWork.id} 是修改工作（单一写入者），不接受协作加入`);
      }
      if (this.store.hasInboundSourcedSubAgentTask(reusedWork.subAgentId)) {
        throw new SubAgentDelegationError("forbidden", "该工作源自入站事件的宿主固定评审：不接受协作加入");
      }
    }
    // 限额（查重后）：同一会话的活动执行任务上限；宿主评审（issue 19）不占
    // 模型委派名额（计数 SQL 已按来源事件排除，这里直接跳过，避免宿主固定
    // 评审被拥有者的活动委派挤掉）
    if (!input.hostReview) {
      const active = this.store.countActiveSubAgentTasks(parentSession.id);
      if (active >= SUBAGENT_LIMITS.perParentSession) {
        throw new SubAgentDelegationError(
          "limit_exceeded",
          `本会话的活动 SubAgent 任务已达上限 ${SUBAGENT_LIMITS.perParentSession}，等现有任务结束后再委派`,
        );
      }
    }

    // —— 异步准备（无事务；不做文件系统与内核之外的跨系统原子承诺）——
    const newAgent = target === null;
    const workId = reusedWork ? reusedWork.id : randomId("work");
    const agentId = target ? target.id : randomId("sagent");
    const workDir = target ? target.workDir : path.join(this.deps.workRoot, agentId);
    // 发起任务的有效模式预检；受限模式缺后端仍明确失败。
    const launcher = this.deps.launcherFor(policy.accessMode);
    if (policy.protectSource && launcher.kind !== "native") throw new SubAgentDelegationError("source_protection_unavailable", "角色要求原生沙箱保护来源；请恢复受限执行环境后重新委派");
    const selection = parent.modelSelection;
    if (!selection) throw new SubAgentDelegationError("model_selection_missing", "发起任务缺少已保存的模型选择，请新建任务后委派");
    const check = await this.deps.resolveSelection(selection);
    const deadline = new Date(Date.parse(parent.startedAt ?? parent.createdAt) + SUBAGENT_LIMITS.deadlineMs).toISOString();

    // —— 修改委派（issue 16）：写入目标在事务外准备（worker 创建 worktree 或
    // 非 Git 写预检），事务内钉定；继续委派沿用工作原有 writeTarget ——
    let writeTarget: WorkWriteTarget | null = reusedWork?.writeTarget ?? null;
    if (input.target != null) {
      if (reusedWork) {
        // 继续委派：沿用工作原有 writeTarget（首次钉定）；只读工作不能升级为写入
        writeTarget = reusedWork.writeTarget;
        if (!writeTarget) {
          throw new SubAgentDelegationError("invalid_state", `工作 ${reusedWork.id} 没有修改目标，请新建有目标的工作`);
        }
      } else {
        try {
          writeTarget = await this.workCopies.prepareWriteTarget(input.target, parentSession, workId, parent.id, undefined, { gitOnly: policy.protectSource });
        } catch (err) {
          if (err instanceof WorkCopyError) throw new SubAgentDelegationError(err.code, err.message);
          throw err;
        }
      }
    }
    if (policy.protectSource && writeTarget?.kind === "direct") throw new SubAgentDelegationError("source_protection_conflict", "角色要求保护来源，不能原地执行；请使用 Git 目标副本");

    // 宿主模板 + 请求合计不超过 cap（与旧委派一致；超限拒绝，不截断；在 taskInput 内判定）
    let sourceRefs: SourceRef[] = [];
    let scopePaths: SubAgentReadScope["paths"] = [];
    let createdNewDir = false;
    let snapshotFile: string | null = null;
    let inputText: string;
    // 准备或登记失败只清理本次产物：新建目录整删；沿用目录时只删本次写入的快照
    const cleanup = (): void => {
      if (createdNewDir) fs.rmSync(workDir, { recursive: true, force: true });
      else if (snapshotFile) fs.rmSync(snapshotFile, { force: true });
    };
    try {
      if (newAgent) {
        // 宿主生成的独立工作目录（保护根之外；身份在登记事务前核实）
        assertGrantNotProtected(path.resolve(workDir), this.deps.protectedRoots());
        fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
        createdNewDir = true;
      }
      if (input.materials && input.materials.length > 0) {
        // main：在父项目的有效资料权限内解析为文本快照；快照正文落子目录后不
        // 重新解析或改写（按工作+执行键命名，复用不覆写旧工作的快照）；来源引用
        // 随任务保存，发送前复核撤销。
        const resolved = this.deps.sources.resolve(parentSession.projectId, input.materials, parent.id, source?.authority?.grantIds);
        sourceRefs = resolved.refs;
        snapshotFile = path.join(workDir, materialsFileFor(workId, input.key));
        fs.writeFileSync(snapshotFile, resolved.text, { encoding: "utf8", mode: 0o600 });
      } else if (input.readPaths && input.readPaths.length > 0) {
        scopePaths = this.prepareReadPaths(parent, parentSession, input.readPaths);
      }
      inputText = this.taskInput(workId, { ...parent, accessMode: policy.accessMode }, input, (input.materials?.length ?? 0) > 0, scopePaths, writeTarget);
    } catch (err) {
      cleanup();
      throw err;
    }

    const readScope: SubAgentReadScope = { paths: scopePaths, sourceRefs, readMemories: [], ...(execution ? { execution } : {}) };
    // 任务提交摘要：覆盖逻辑参数与任务身份，不含本次调用的父任务 id、模型选择
    // 与截止时间——跨轮次重放核实的是同一逻辑委派，返回首次记录。
    const submissionDigest = taskSubmissionDigest(workId, agentId, input.paramsDigest);
    const requestId = subAgentTaskRequestId(workId, input.key);

    // —— 同步事务：重核后一次性登记 ——
    let outcome: SubAgentDelegation;
    try {
      outcome = this.store.withTx(() => {
        // 新工作路径：同键在本调用准备期间已提交 → 同参返回、异参冲突（纯读，
        // 与事务外查重同一入口），不再落到 UNIQUE 约束的原始报错
        if (!input.workId) {
          const hit = this.dedupNewKey(input, parentSession);
          if (hit) return hit;
        }
        // 竞争仲裁（继续/协作加入）：同键可能已在本调用准备期间提交；键按目标
        // Agent 的会话核实（不同协作方的同键互相独立）
        const racedWork = this.store.getWorkDelegation(workId);
        // 与整项取消的竞争：两个同步事务串行，后到者在这里被拒绝（零新任务）
        if (racedWork?.canceledAt) {
          throw new SubAgentDelegationError("invalid_state", `工作已取消（${racedWork.canceledAt}）：不能继续委派`);
        }
        const agentNow = target ? this.store.getSubAgent(target.id) : null;
        if (target && !agentNow) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${target.id}`);
        if (agentNow) {
          this.assertRole(agentNow, input.role);
          if (requireSubAgentDefinition(agentNow).digest !== definition.digest) throw new SubAgentDelegationError("definition_corrupt", "SubAgent 的固定角色记录已变化，请停止并核实记录");
        }
        const racedTask = agentNow ? this.store.findTaskByRequest(agentNow.sessionId, requestId) : null;
        if (racedWork && agentNow && racedTask) {
          if (racedWork.parentSessionId !== parentSession.id || racedTask.submissionDigest !== submissionDigest) {
            throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定参数不同的记录`);
          }
          return { work: racedWork, agent: agentNow, task: racedTask, created: false, newWork: false };
        }
        if (!input.hostReview && this.store.countActiveSubAgentTasks(parentSession.id) >= SUBAGENT_LIMITS.perParentSession) {
          throw new SubAgentDelegationError("limit_exceeded", "本会话的 SubAgent 名额已用满，请等待现有执行结束");
        }
        check(); // 模型门闩重检必须在登记事务内
        // 可用性事务内重核：关闭/忙碌与登记的竞争在这里定胜负（先关闭则报已
        // 关闭；先登记则关闭侧报有活动任务）
        if (agentNow) {
          this.assertAvailable(agentNow, parentSession, reusedWork);
        }
        // 准备后、提交前撤销的资料不得进入子上下文：复核该 Agent 历史任务与
        // 本次任务的来源引用并集（复用保留的上下文含旧工作资料；快照正文不重
        // 新解析）
        const previousTasks = agentNow ? this.store.listTasksBySession(agentNow.sessionId) : [];
        const scopes = [...previousTasks.map(task => ({ refs: task.readScope?.sourceRefs ?? [], taskId: task.id, grantIds: task.readScope?.execution?.source.authority?.grantIds })),
          { refs: readScope.sourceRefs, taskId: parent.id, grantIds: source?.authority?.grantIds }];
        for (const scope of scopes) {
          const problem = this.deps.sources.verify(parentSession.projectId, scope.refs as SourceRef[], scope.taskId, scope.grantIds);
          if (problem) {
            throw new SubAgentDelegationError("forbidden", `资料授权已在提交前变化，拒绝登记：${problem}`);
          }
        }
        const parentNow = this.store.getTask(parent.id);
        if (!parentNow || parentNow.sessionId !== parentSession.id) {
          throw new SubAgentDelegationError("forbidden", "父任务归属已变化，拒绝登记");
        }
        this.assertSource(parentNow, parent, input.hostReview);
        if (source && !this.deps.verifySource?.(source)) throw new SubAgentDelegationError("source_invalid", "来源授权或配置在准备期间变化；未登记子任务，请核实后重新委派");
        if (!isDeepStrictEqual(parentNow.modelSelection, selection)) throw new SubAgentDelegationError("model_config_busy", "发起任务的模型选择在准备期间变化，请重新委派");
        if (input.workId && !racedWork) {
          // 竞争窗口内工作被另一请求按不同 workId 登记同一键
          const byKey = this.store.findWorkDelegation(parentSession.id, input.key);
          if (byKey) throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定另一工作 ${byKey.id}`);
        }
        let agent: SubAgent;
        let work: WorkDelegation;
        let newWork = false;
        if (racedWork && agentNow) {
          // 继续或协作加入（issue 13）：任务登记在既有工作上；协作加入的任务
          // 关联列指向协作方 Agent（工作行保持首次承接者）
          agent = agentNow;
          work = racedWork;
        } else if (agentNow) {
          // 复用：登记新工作指向既有 Agent（同一子会话，上下文保留；TUI 按
          // “同一 SubAgent 的新工作”分支处理创建事件）
          work = {
            id: workId,
            parentSessionId: parentSession.id,
            originTaskId: parent.id,
            subAgentId: agentNow.id,
            requestKey: input.key,
            paramsDigest: input.paramsDigest,
            canceledAt: null,
            canceledBy: null,
            cancelReason: null,
            writeTarget,
            createdAt: new Date().toISOString(),
          };
          this.store.insertWorkDelegation(work);
          if (writeTarget) {
            // 修改委派（issue 16）：首次钉定写入目标后，Agent 会话 cwd 对齐
            // 到写入根（后续任务经 taskWorkspace 复用同一占用键与 LaunchSpec）
            this.store.setSubAgentCwd(agentNow.id, writeTarget.path, fs.realpathSync(writeTarget.path), writeTarget.dev, writeTarget.ino);
          }
          agent = agentNow;
          newWork = true;
        } else {
          const stat = fs.statSync(fs.realpathSync(workDir));
          const session = this.store.createSession({
            projectId: parentSession.projectId,
            kind: "dev",
            cwd: workDir,
            cwdReal: fs.realpathSync(workDir),
            cwdDev: stat.dev,
            cwdIno: stat.ino,
            piSessionId: randomId("pi"),
            confirmTools: [],
            modelSelection: selection,
          });
          const now = new Date().toISOString();
          agent = {
            id: agentId,
            parentSessionId: parentSession.id,
            sessionId: session.id,
            workDir,
            activeWorkId: workId,
            currentTaskId: null,
            state: "running",
            closedAt: null,
            closedBy: null,
            createdAt: now,
            definition,
          };
          this.store.insertSubAgent(agent);
          work = {
            id: workId,
            parentSessionId: parentSession.id,
            originTaskId: parent.id,
            subAgentId: agentId,
            requestKey: input.key,
            paramsDigest: input.paramsDigest,
            canceledAt: null,
            canceledBy: null,
            cancelReason: null,
            writeTarget,
            createdAt: now,
          };
          this.store.insertWorkDelegation(work);
          if (writeTarget) {
            this.store.setSubAgentCwd(agentId, writeTarget.path, fs.realpathSync(writeTarget.path), writeTarget.dev, writeTarget.ino);
          }
          newWork = true;
        }
        const { task, duplicate } = this.store.insertQueuedTask({
          sessionId: agent.sessionId,
          requestId,
          input: inputText,
          accessMode: policy.accessMode,
          sourcePermissionVersion: parent.permissionVersion,
          modelSelection: selection,
          submissionDigest,
          parentTaskId: parent.id,
          sourceEventId: input.hostReview?.sourceEventId ?? null,
          deadline,
          workId,
          subAgentId: agent.id,
          readScope,
        });
        if (duplicate) {
          return { work, agent, task, created: false, newWork };
        }
        const scheduled = getCodeScheduledTaskSource(this.store, parent.id);
        if (scheduled) bindCodeScheduleTask(this.store, { runId: scheduled.runId, taskId: task.id, sourceTaskId: parent.id });
        this.store.setSubAgentState(agent.id, "running", { activeWorkId: workId, currentTaskId: task.id });
        if (newWork) {
          this.store.appendEvent(
            {
              type: "work_delegation.created",
              workId,
              parentSessionId: parentSession.id,
              subAgentId: agent.id,
              agentSessionId: agent.sessionId,
              taskId: task.id,
            },
            { taskId: task.id, sessionId: parentSession.id },
          );
        }
        return { work, agent, task, created: true, newWork };
      });
    } catch (err) {
      cleanup();
      throw err;
    }
    if (outcome.created) this.deps.kickSession(outcome.agent.sessionId);
    return outcome;
  }

  /**
   * 显式关闭（issue 12）：一个同步事务内完成核实与写入。主 Agent 发起时必须
   * 属于本父会话；已关闭幂等返回；有活动任务（queued/running/
   * awaiting_confirmation）拒绝并给出任务 id——先关闭再委派报已关闭、先委派
   * 再关闭报有活动任务，不存在「已关闭且有活动任务」的中间态。不删除工作
   * 目录、会话、历史、产物与工作记录。
   */
  close(input: { subAgentId: string; by: SubAgentClosedBy; parentSessionId?: string }): { agent: SubAgent; alreadyClosed: boolean } {
    const out = this.store.withTx(() => {
      const agent = this.store.getSubAgent(input.subAgentId);
      if (!agent) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${input.subAgentId}`);
      if (input.by.startsWith("agent:") && agent.parentSessionId !== input.parentSessionId) {
        throw new SubAgentDelegationError("forbidden", "该 SubAgent 不属于本会话");
      }
      if (agent.closedAt) return { agent, alreadyClosed: true };
      const activeTask = this.store.findActiveSubAgentTask(agent.id);
      if (activeTask) {
        throw new SubAgentDelegationError(
          "busy",
          `SubAgent 有活动任务 ${activeTask.id}：等任务结束，或由拥有者 ruukoto cancel ${activeTask.id} 后再关闭`,
        );
      }
      const at = new Date().toISOString();
      if (!this.store.closeSubAgent(agent.id, at, input.by)) {
        return { agent: this.store.getSubAgent(agent.id)!, alreadyClosed: true };
      }
      const byTaskId = input.by.startsWith("agent:") ? input.by.slice("agent:".length) : null;
      this.store.appendEvent(
        {
          type: "subagent.closed",
          subAgentId: agent.id,
          parentSessionId: agent.parentSessionId,
          closedBy: input.by,
          taskId: byTaskId,
        },
        { taskId: byTaskId, sessionId: agent.parentSessionId },
      );
      for (const msg of this.store.listPendingSubAgentMessages(agent.parentSessionId)) {
        if (msg.toSubAgentId === agent.id) this.pendingMessageContext(msg);
      }
      return { agent: this.store.getSubAgent(agent.id)!, alreadyClosed: false };
    });
    return out;
  }

  /**
   * 整项取消（issue 14）：一个事务登记，停止在事务外完成。
   * - 事务内：写取消字段（条件为未取消，重复取消幂等返回原记录）；本工作的
   *   排队任务直接转为 canceled（errorMessage 记 work_canceled）；活动任务
   *   写取消意图（cancel_requested=1，覆盖已转 running 而未登记 currentTask
   *   的窗口）；追加 work_delegation.canceled 事件。与委派登记同为同步事务
   *   天然串行：先登记的任务必然在本清单内，后登记的必然被拒，不会遗漏。
   * - 提交后：对每个活动任务调用 Runtime.cancelTask 按现有停止路径处理
   *   （快照账本、解除审批等待、abort、回收进程组、终态补记）；无法回收的
   *   执行按现有逻辑保留占用，SubAgent 记为 unverified。
   * 主 Agent 发起时核对父会话归属。取消不关闭 SubAgent、不删除历史/产物/
   * 工作目录；迟到结果保存为事实，但不再自动送进任何父模型（见编排器与
   * 队列循环的回报门）。
   */
  async cancelWork(input: { workId: string; by: WorkCanceledBy; reason?: string | null; parentSessionId?: string }): Promise<WorkCancellation> {
    const prepared = this.store.withTx(() => {
      const work = this.store.getWorkDelegation(input.workId);
      if (!work) throw new SubAgentDelegationError("not_found", `工作委托不存在：${input.workId}`);
      const identity = this.store.getSessionIdentity(this.store.getSubAgent(work.subAgentId)?.sessionId ?? "");
      if (identity?.kind === "subagent" && identity.workflow) throw new SubAgentDelegationError("invalid_state", "工作流步骤由所属运行控制，请取消运行");
      if (input.by.startsWith("agent:") && work.parentSessionId !== input.parentSessionId) {
        throw new SubAgentDelegationError("forbidden", "该工作委托不属于本会话");
      }
      if (work.canceledAt) return { work, alreadyCanceled: true, stopping: [] as Task[] };
      const active = this.store.listActiveTasksByWork(work.id);
      const now = new Date().toISOString();
      const stopping: Task[] = [];
      const canceled: Task[] = [];
      for (const t of active) {
        if (t.status === "queued") {
          const ok = this.store.endTask(t.id, ["queued"], "canceled", { errorMessage: "work_canceled", endedAt: now });
          if (ok) {
            canceled.push(t);
          }
        } else {
          this.store.setCancelRequested(t.id, true);
          stopping.push(t);
        }
      }
      const reason = input.reason?.trim() ? input.reason.trim() : null;
      if (!this.store.cancelWorkDelegation(work.id, now, input.by, reason)) {
        return { work: this.store.getWorkDelegation(work.id)!, alreadyCanceled: true, stopping: [] as Task[] };
      }
      const byTaskId = input.by.startsWith("agent:") ? input.by.slice("agent:".length) : null;
      this.store.appendEvent(
        {
          type: "work_delegation.canceled",
          workId: work.id,
          parentSessionId: work.parentSessionId,
          subAgentId: work.subAgentId,
          canceledBy: input.by,
          reason,
          canceledTaskIds: canceled.map((t) => t.id),
          stoppingTaskIds: stopping.map((t) => t.id),
        },
        { taskId: byTaskId, sessionId: work.parentSessionId },
      );
      return { work: this.store.getWorkDelegation(work.id)!, alreadyCanceled: false, stopping };
    });
    // 事务外：活动任务按现有停止路径逐个处理（已自然终态的由 cancelTask 拒绝，忽略）
    await Promise.allSettled(prepared.stopping.map((t) => this.deps.cancelTask(t.id, "work_canceled")));
    // 已取消工作的待投递消息有明确结果（issue 13）：记 work_canceled，不再投递
    await this.flushPendingMessages(prepared.work.parentSessionId);
    return { work: prepared.work, alreadyCanceled: prepared.alreadyCanceled, tasks: this.store.listTasksByWork(prepared.work.id) };
  }

  // ---------- 工作内协作消息（agent-direction issue 13） ----------

  /**
   * 发送工作内消息：一个同步事务完成身份与资格核实、幂等查重、登记与可投递
   * 时的投递（提交后 kick）。发送方身份完全由发起任务核实：SubAgent 任务（
   * 任务的工作必须正是本工作）或工作父会话的任务（主 Agent）；其他会话、
   * 其他工作的任务一律拒绝。接收方必须是当前承接本工作的 SubAgent
   * （activeWorkId === 本工作；复用转做其他工作后旧协作者资格即失）且未
   * 关闭；发给主 Agent 省略 toSubAgentId。同键同参返回原记录（即使此后已
   * 关闭/资格已失），异参冲突。消息不扩大接收方的工具与资料范围。
   */
  async message(input: SubAgentMessageInput): Promise<SubAgentMessageResult> {
    const initial = this.messageContext(input);
    if ("hit" in initial) return initial.hit;
    const prepared = await this.prepareMessageDelivery(initial.work, initial.target, initial.senderTask.accessMode, initial.senderTask.id);
    const kicks: string[] = [];
    const out = this.store.withTx(() => {
      const context = this.messageContext(input);
      if ("hit" in context) return context.hit;
      const { work, sender, senderTask, target, text } = context;
      this.assertSource(senderTask, initial.senderTask);
      this.checkMessageDelivery(work, target, prepared, senderTask.id);
      const msg: SubAgentMessage = {
        id: randomId("smsg"),
        workId: work.id,
        parentSessionId: work.parentSessionId,
        fromSubAgentId: sender?.id ?? null,
        fromTaskId: input.senderTaskId,
        accessMode: senderTask.accessMode,
        sourcePermissionVersion: senderTask.permissionVersion,
        toSubAgentId: target?.id ?? null,
        requestKey: input.key,
        paramsDigest: input.paramsDigest,
        body: text,
        createdAt: new Date().toISOString(),
        deliveredTaskId: null,
        deliveredAt: null,
        undeliveredReason: null,
      };
      this.store.insertSubAgentMessage(msg);
      const delivery = this.deliverIfPossible(msg, work, target, prepared?.selection ?? null, kicks);
      // 登记事件每条消息至多一条（含当时的投递判定）；冲刷只改变行与任务，
      // 不再补 sent 事件——未送达的最终结果由 dropped 事件记录
      this.appendMessageEvent(msg, delivery, delivery === "task" || delivery === "wake" ? this.store.getSubAgentMessage(msg.id)!.deliveredTaskId : null);
      return { message: this.store.getSubAgentMessage(msg.id)!, created: true, delivery };
    });
    for (const sessionId of kicks) this.deps.kickSession(sessionId);
    return out;
  }

  /** 查重在预检前；准备后重入同一判定，关闭/取消/复用不能穿过等待窗口。 */
  private messageContext(input: SubAgentMessageInput):
    { hit: SubAgentMessageResult } | { work: WorkDelegation; sender: SubAgent | null; senderTask: Task; target: SubAgent | null; text: string } {
    const senderTask = this.store.getTask(input.senderTaskId);
    if (!senderTask) throw new SubAgentDelegationError("not_found", `发起任务不存在：${input.senderTaskId}`);
    const work = this.store.getWorkDelegation(input.workId);
    if (!work) throw new SubAgentDelegationError("not_found", `工作委托不存在：${input.workId}`);
    const sender = senderTask.subAgentId ? this.store.getSubAgent(senderTask.subAgentId) : null;
    if (senderTask.subAgentId && !sender) throw new SubAgentDelegationError("not_found", `任务 ${senderTask.id} 缺少 SubAgent 记录`);
    if (sender) {
      if (senderTask.workId !== work.id) throw new SubAgentDelegationError("forbidden", "只能从本工作的执行任务中发送本工作消息（跨当前工作范围的消息被拒绝）");
      if (this.store.hasInboundSourcedSubAgentTask(sender.id)) throw new SubAgentDelegationError("forbidden", "宿主固定评审的 SubAgent 不参与工作内通信");
    } else if (senderTask.sessionId !== work.parentSessionId) {
      throw new SubAgentDelegationError("forbidden", "只能在本工作的父会话中发送工作内消息");
    }
    const hit = this.store.findSubAgentMessage(work.id, sender?.id ?? null, input.key);
    if (hit) {
      if (hit.paramsDigest !== input.paramsDigest) throw new SubAgentDelegationError("request_conflict", `消息幂等键冲突：${input.key} 已绑定参数不同的消息 ${hit.id}`);
      return { hit: { message: hit, created: false, delivery: null } };
    }
    this.assertSource(senderTask);
    if (work.canceledAt) throw new SubAgentDelegationError("invalid_state", `工作已取消（${work.canceledAt}）：不能投递消息`);
    const text = input.text.trim();
    if (!text) throw new SubAgentDelegationError("invalid_params", "消息正文不能为空");
    if (text.length > MESSAGE_TEXT_CAP) throw new SubAgentDelegationError("invalid_params", `消息正文超过 ${MESSAGE_TEXT_CAP} 字符，请精简`);
    const target = input.toSubAgentId ? this.store.getSubAgent(input.toSubAgentId) : null;
    if (input.toSubAgentId && !target) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${input.toSubAgentId}`);
    if (target) {
      if (sender?.id === target.id) throw new SubAgentDelegationError("invalid_params", "不能发送给自己");
      const problem = this.eligibility(target, work.parentSessionId, work, "receive");
      if (problem && problem.code !== "busy") throw new SubAgentDelegationError(problem.code, problem.message);
    } else if (!input.toSubAgentId && !sender) {
      throw new SubAgentDelegationError("invalid_params", "主 Agent 发送时必须指定接收的 SubAgent（to_sub_agent_id）");
    }
    return { work, sender, senderTask, target, text };
  }

  /** 只有真正需要建执行任务的消息才预检模型与登记时的执行模式。 */
  private messageSelection(work: WorkDelegation, target: SubAgent | null, sourceTaskId: string): ModelSelection | null {
    if (target) {
      const selection = this.store.getTask(sourceTaskId)?.modelSelection;
      if (!selection) throw new SubAgentDelegationError("model_selection_missing", "消息来源任务缺少已保存的模型选择，请停止并核实记录");
      return selection;
    }
    const identity = this.store.getSessionIdentity(work.parentSessionId);
    const scheduled = getCodeScheduledTaskSource(this.store, sourceTaskId);
    if (scheduled) return scheduled.snapshot.modelSelection;
    return identity?.kind === "main" ? identity.role.modelSelection ?? this.deps.defaultModelSelection()
      : identity?.kind === "scheduled" ? identity.modelSelection ?? this.deps.defaultModelSelection() : null;
  }

  private async prepareMessageDelivery(work: WorkDelegation, target: SubAgent | null, accessMode: AccessMode, sourceTaskId: string): Promise<{ selection: ModelSelection; check: () => void } | null> {
    const selection = this.messageSelection(work, target, sourceTaskId);
    if (!selection) return null;
    if (target) accessMode = this.messageAccessMode(work, target, accessMode);
    this.deps.launcherFor(accessMode);
    const check = await this.deps.resolveSelection(selection);
    return { selection, check };
  }

  private messageAccessMode(work: WorkDelegation, target: SubAgent, sourceMode: AccessMode): AccessMode {
    if (this.deps.source) {
      const previous = this.store.listTasksBySession(target.sessionId).filter(task => task.workId === work.id).at(-1);
      const old = requireSubAgentExecutionScope(previous?.readScope).execution.accessMode;
      if (old === "confirm" || sourceMode === "confirm") sourceMode = "confirm";
      else if (old === "auto-review" || sourceMode === "auto-review") sourceMode = "auto-review";
    }
    return subAgentAccessPolicy(sourceMode, validateSubAgentRole(requireSubAgentDefinition(target))).accessMode;
  }

  private checkMessageDelivery(work: WorkDelegation, target: SubAgent | null, prepared: { selection: ModelSelection; check: () => void } | null, sourceTaskId: string): void {
    if (!isDeepStrictEqual(this.messageSelection(work, target, sourceTaskId), prepared?.selection ?? null)) {
      throw new SubAgentDelegationError("model_config_busy", "消息的模型选择在准备期间变化，请重试");
    }
    prepared?.check();
  }

  /**
   * 冲刷待投递消息（任务终态、启动、取消、队列恢复和模型配置应用结束时调用）。
   * 逐条重核资格：可投递则投递（任务/唤醒），资格已失或工作已取消记明确未
   * 投递结果；仍忙碌或名额满保持待投递。事务外异步预检，事务内重核并投递，
   * 重入与崩溃恢复不重复（投递按 smsg:<消息ID> 请求键 + 一次写入标记）。
   */
  async flushPendingMessages(parentSessionId?: string): Promise<void> {
    for (const msg of this.store.listPendingSubAgentMessages(parentSessionId)) {
      const initial = this.store.withTx(() => this.pendingMessageContext(msg));
      if (!initial) continue;
      try {
        const prepared = await this.prepareMessageDelivery(initial.work, initial.target, msg.accessMode, msg.fromTaskId);
        const kicks: string[] = [];
        this.store.withTx(() => {
          const current = this.pendingMessageContext(msg);
          if (!current) return;
          this.checkMessageDelivery(current.work, current.target, prepared, msg.fromTaskId);
          this.deliverIfPossible(msg, current.work, current.target, prepared?.selection ?? null, kicks);
        });
        for (const sessionId of kicks) this.deps.kickSession(sessionId);
      } catch (err) {
        // 配置忙、模型或执行入口不可用均不改既有消息；恢复后以原消息键重核补投。
        this.log(`消息 ${msg.id} 仍待投递：${(err as Error).message}`);
      }
    }
  }

  /** 只在事务内调用：既有消息资格失效就留明确结果，忙碌与名额满仍待投递。 */
  private pendingMessageContext(msg: SubAgentMessage): { work: WorkDelegation; target: SubAgent | null } | null {
    const current = this.store.getSubAgentMessage(msg.id);
    if (!current || current.deliveredAt || current.undeliveredReason) return null;
    try { getCodeScheduledTaskSource(this.store, msg.fromTaskId); }
    catch (error) {
      if (!(error instanceof CodeScheduleError)) throw error;
      this.dropMessage(msg, error.code);
      return null;
    }
    let work: WorkDelegation | null;
    try { work = this.store.getWorkDelegation(msg.workId); }
    catch (error) {
      if (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code)) throw error;
      this.dropMessage(msg, error.code);
      return null;
    }
    if (!work || work.canceledAt) {
      this.dropMessage(msg, work ? "work_canceled" : "work_missing");
      return null;
    }
    try { this.verifyWorkspace(work); }
    catch (error) {
      if (!(error instanceof WorkCopyError) && (!(error instanceof WorkspaceSnapshotError) || !["target_corrupt", "snapshot_missing", "snapshot_corrupt"].includes(error.code))) throw error;
      this.dropMessage(msg, error.code);
      return null;
    }
    if (!msg.toSubAgentId) {
      const kind = this.store.getSessionIdentity(work.parentSessionId)?.kind;
      return kind === "main" || kind === "scheduled" || getCodeScheduleRunForTask(this.store, msg.fromTaskId) ? { work, target: null } : null;
    }
    const target = this.store.getSubAgent(msg.toSubAgentId);
    if (!target) { this.dropMessage(msg, "agent_missing"); return null; }
    const problem = this.eligibility(target, work.parentSessionId, work, "receive");
    if (problem) {
      if (problem.code !== "busy") this.dropMessage(msg, problem.reason);
      return null;
    }
    if (this.deps.source) {
      try {
        this.messageAccessMode(work, target, msg.accessMode);
        const previous = this.store.listTasksBySession(target.sessionId).filter(task => task.workId === work.id).at(-1);
        const source = requireSubAgentExecutionScope(previous?.readScope).execution.source;
        if (!this.deps.verifySource?.(source)) {
          this.dropMessage(msg, this.store.getScheduledRunForTask(source.taskId)?.scheduleStatus === "canceled" ? "work_canceled" : "source_invalid");
          return null;
        }
      } catch (error) {
        if (!(error instanceof SubAgentExecutionError)) throw error;
        this.dropMessage(msg, error.code);
        return null;
      }
    }
    if (this.store.countActiveSubAgentTasks(work.parentSessionId) >= SUBAGENT_LIMITS.perParentSession) return null;
    return { work, target };
  }

  /** 发送时按接收方状态的投递判定（flushPendingMessages 的逐条判定共用下方 deliver*）。 */
  private deliverIfPossible(
    msg: SubAgentMessage,
    work: WorkDelegation,
    target: SubAgent | null,
    selection: ModelSelection | null,
    kicks: string[],
  ): "task" | "wake" | "inject" | "pending" {
    if (target === null) {
      const delivery = this.deps.parentDelivery.messageRecorded(msg, work, selection);
      if (delivery === "wake") kicks.push(work.parentSessionId);
      return delivery;
    }
    if (this.eligibility(target, work.parentSessionId, work, "receive")) return "pending";
    if (this.store.countActiveSubAgentTasks(work.parentSessionId) >= SUBAGENT_LIMITS.perParentSession) return "pending";
    if (!selection) throw new Error("消息投递缺少已核实的模型选择");
    this.deliverAsTask(msg, work, target, selection, kicks);
    return "task";
  }

  /**
   * 投递为接收方的本工作执行任务（登记时的发送任务模式；读范围沿用本工作最近一次
   * 任务的钉定——消息不扩大任何范围）。登记、标记、占用状态与事件同一事务。
   */
  private deliverAsTask(msg: SubAgentMessage, work: WorkDelegation, agent: SubAgent, selection: ModelSelection, kicks: string[]): void {
    this.assertRole(agent);
    const scope = this.store.listTasksBySession(agent.sessionId).filter(t => t.workId === work.id).at(-1)?.readScope ?? null;
    const accessMode = this.messageAccessMode(work, agent, msg.accessMode);
    let readScope = scope;
    if (this.deps.source) {
      const old = requireSubAgentExecutionScope(scope).execution;
      if (!this.deps.verifySource?.(old.source)) throw new SubAgentExecutionError("source_invalid");
      readScope = { ...scope!, execution: snapshotSubAgentExecution({ ...old, accessMode }) };
    }
    const { task } = this.store.insertQueuedTask({
      sessionId: agent.sessionId,
      requestId: `smsg:${msg.id}`,
      input: this.messageTaskInput(msg, work),
      accessMode,
      sourcePermissionVersion: msg.sourcePermissionVersion,
      modelSelection: selection,
      submissionDigest: createHash("sha256").update(JSON.stringify({ kind: "smsg", messageId: msg.id })).digest("hex"),
      parentTaskId: msg.fromTaskId,
      deadline: new Date(Date.now() + SUBAGENT_LIMITS.deadlineMs).toISOString(),
      workId: work.id,
      subAgentId: agent.id,
      readScope,
    });
    const scheduled = getCodeScheduledTaskSource(this.store, msg.fromTaskId);
    if (scheduled) bindCodeScheduleTask(this.store, { runId: scheduled.runId, taskId: task.id, sourceTaskId: msg.fromTaskId });
    const now = new Date().toISOString();
    if (this.store.markSubAgentMessageDelivered(msg.id, task.id, now)) {
      this.store.setSubAgentState(agent.id, "running", { activeWorkId: work.id, currentTaskId: task.id });
      kicks.push(agent.sessionId);
    }
  }

  /** 明确未投递结果（一次写入；与投递登记互斥）及事件。 */
  private dropMessage(msg: SubAgentMessage, reason: string): void {
    if (!this.store.markSubAgentMessageUndelivered(msg.id, reason)) return;
    this.store.appendEvent(
      { type: "subagent_message.dropped", messageId: msg.id, workId: msg.workId, parentSessionId: msg.parentSessionId, toSubAgentId: msg.toSubAgentId, reason },
      { sessionId: msg.parentSessionId },
    );
  }

  private appendMessageEvent(msg: SubAgentMessage, delivery: "task" | "wake" | "inject" | "pending", taskId: string | null): void {
    this.store.appendEvent(
      {
        type: "subagent_message.sent",
        messageId: msg.id,
        workId: msg.workId,
        parentSessionId: msg.parentSessionId,
        fromSubAgentId: msg.fromSubAgentId,
        fromTaskId: msg.fromTaskId,
        toSubAgentId: msg.toSubAgentId,
        delivery,
        taskId,
      },
      { taskId: msg.fromTaskId, sessionId: msg.parentSessionId },
    );
  }

  /** 投递任务的输入：宿主固定首行与来源说明（模型只见正文，不能伪造首行）。 */
  private messageTaskInput(msg: SubAgentMessage, work: WorkDelegation): string {
    const from = msg.fromSubAgentId
      ? `来自：SubAgent ${msg.fromSubAgentId}（工作 ${work.id}，执行任务 ${msg.fromTaskId}）。`
      : `来自：主 Agent（父会话任务 ${msg.fromTaskId}）。`;
    const body = [
      `[工作内消息 · 工作 ${work.id}]`,
      `消息 ${msg.id}。${from}`,
      "这是同项工作协作方发来的消息，作为本工作的一次执行任务送达：工具分工与资料 API 范围沿用本工作，访问模式由宿主采用消息登记时的发起任务授权。",
      "要回复或向同项工作的协作方补充，用 subagent_message（work_id 用本工作；省略 to_sub_agent_id 发给主 Agent）；结束时的最终回答仍作为本工作结果回到主 Agent。",
      `---\n${msg.body}`,
    ].join("\n");
    if (body.length > INPUT_TEXT_CAP) {
      throw new SubAgentDelegationError("invalid_params", `消息正文（含来源说明）超过 ${INPUT_TEXT_CAP} 字符，请精简`);
    }
    return body;
  }

  /** 汇入该工作相对捕获基线的完整子增量，不提交；工作活动、基线失效或来源受影响文件变化时拒绝，保留双方成果。
   * 取消/关闭仍可汇入保留副本，工作流成果只能由所属运行汇入；套用与 SQLite 事件登记不是跨文件原子。
   * Note: 见 .agents/notes/implemented/architecture/2026-10-15-current-workspace-snapshots.md
   */
  async integrate(input: { workId: string; parentTaskId: string; parentSessionId: string }): Promise<WorkIntegration> {
    const work = this.store.getWorkDelegation(input.workId);
    if (!work || work.parentSessionId !== input.parentSessionId) {
      throw new SubAgentDelegationError("not_found", `工作委托不存在或不属于本会话：${input.workId}`);
    }
    const agent = this.store.getSubAgent(work.subAgentId);
    const identity = agent ? this.store.getSessionIdentity(agent.sessionId) : null;
    if (identity?.kind === "subagent" && identity.workflow) throw new SubAgentDelegationError("invalid_state", "工作流成果必须由所属运行经过独立验证后汇总");
    const target = work.writeTarget;
    if (!target) {
      throw new SubAgentDelegationError("invalid_state", `工作 ${work.id} 没有写入目标或副本可汇总；直接报告独立目录中的结果与产物`);
    }
    if (target.kind === "direct") {
      return { work, state: "direct", filesChanged: 0, insertions: 0, deletions: 0, files: [], baseCommit: null, parentHead: null };
    }
    const parentSession = this.store.getSession(input.parentSessionId);
    if (!parentSession) throw new SubAgentDelegationError("not_found", `父会话不存在：${input.parentSessionId}`);
    const parentTask = this.store.getTask(input.parentTaskId);
    if (!parentTask || parentTask.sessionId !== input.parentSessionId) {
      throw new SubAgentDelegationError("forbidden", "发起任务不属于本会话");
    }
    // 忙碌：副本可能仍在被在跑的执行改写，等它结束再汇总
    const active = this.store.listActiveTasksByWork(work.id);
    if (active.length > 0) {
      throw new SubAgentDelegationError("busy", `工作有活动任务 ${active[0]!.id}：等该执行结束后再汇总`);
    }
    let parsed: Awaited<ReturnType<WorkCopyManager["integrate"]>>;
    try {
      parsed = await this.workCopies.integrate({ work, target, parentSession, parentTaskId: parentTask.id });
    } catch (err) {
      if (err instanceof WorkCopyError) throw new SubAgentDelegationError(err.code, err.message);
      throw err;
    }
    if (parsed.state === "conflict") {
      throw new SubAgentDelegationError(
        "integrate_conflict",
        `汇总冲突（工作 ${work.id}）：副本增量未通过套用预检；具体原因见下方 Git 或目标内容诊断。` +
          `父工作区原改动与副本成果 ${target.path} 都保留，未写入任何字节。冲突明细：${parsed.detail}` +
          `。待处理：由你或拥有者在父工作区核对差异后手动处理，或让 SubAgent 继续修正后再汇总`,
      );
    }
    if (parsed.state === "applied") {
      this.store.withTx(() => {
        this.store.appendEvent(
          {
            type: "work_delegation.integrated",
            workId: work.id,
            parentSessionId: work.parentSessionId,
            subAgentId: work.subAgentId,
            taskId: parentTask.id,
            branch: target.branch,
            baseCommit: target.baseCommit,
            parentHead: parsed.parentHead,
            files: parsed.files.slice(0, INTEGRATE_FILE_LIST_CAP),
            filesChanged: parsed.filesChanged,
            insertions: parsed.insertions,
            deletions: parsed.deletions,
            patchBytes: parsed.patchBytes,
          },
          { taskId: parentTask.id, sessionId: input.parentSessionId },
        );
      });
    }
    return {
      work,
      state: parsed.state,
      filesChanged: parsed.filesChanged,
      insertions: parsed.insertions,
      deletions: parsed.deletions,
      files: parsed.files,
      baseCommit: target.baseCommit,
      parentHead: parsed.parentHead,
    };
  }

  /**
   * 继续/复用的可用性（issue 12）：同一父会话、未关闭、空闲且无活动任务
   * （忙碌明确拒绝不排队——继续委派覆盖 current_task_id 会让在跑任务显示
   * 空闲）；工作目录的 realpath 与目录身份必须与子会话记录一致（核对实际
   * 文件状态，目录被替换/删除时报明确错误，提示新建）。
   * issue 16：worktree 工作的继续委派额外复核 worktree 目录身份与 `.git`
   * 指向的 gitdir（被替换或消失即明确拒绝，不自动重建）。
   */
  private assertAvailable(agent: SubAgent, parentSession: Session, work?: WorkDelegation | null): void {
    const problem = this.eligibility(agent, parentSession.id, work ?? null, "delegate");
    if (problem) throw new SubAgentDelegationError(problem.code, problem.message);
    const session = this.store.getSession(agent.sessionId);
    let real: string;
    let stat: fs.Stats;
    try {
      real = fs.realpathSync(agent.workDir);
      stat = fs.statSync(real);
    } catch {
      throw new SubAgentDelegationError("workdir_gone", `SubAgent 工作目录已不存在或被替换，请新建 SubAgent`);
    }
    if (!session || real !== session.cwdReal || stat.dev !== session.cwdDev || stat.ino !== session.cwdIno) {
      throw new SubAgentDelegationError("workdir_gone", `SubAgent 工作目录已不存在或被替换，请新建 SubAgent`);
    }
    const target = work?.writeTarget ?? null;
    if (target?.kind === "worktree") {
      try {
        this.workCopies.assertCopy(work!, target, "请新建委派");
      } catch (err) {
        if (err instanceof WorkCopyError) throw new SubAgentDelegationError(err.code, err.message);
        throw err;
      }
    }
  }

  private eligibility(
    agent: SubAgent,
    parentSessionId: string,
    work: WorkDelegation | null,
    purpose: "delegate" | "receive",
  ): { code: string; message: string; reason: string } | null {
    if (agent.parentSessionId !== parentSessionId) return { code: "forbidden", message: "该 SubAgent 不属于本会话", reason: "foreign_parent" };
    if (agent.closedAt) return { code: "closed", message: `SubAgent 已关闭（${agent.closedAt}）：${purpose === "receive" ? "消息未投递" : "请新建 SubAgent"}`, reason: `closed:${agent.closedAt}` };
    const identity = this.store.getSessionIdentity(agent.sessionId);
    if (identity?.kind === "subagent" && identity.workflow) return { code: "forbidden", message: "工作流步骤由所属运行管理，不能通过普通委派复用或续派", reason: "workflow_bound" };
    if (this.store.hasInboundSourcedSubAgentTask(agent.id)) return { code: "forbidden", message: "该 SubAgent 的工作源自入站事件（上下文含不可信外部资料）：不能复用或续派", reason: "inbound_review" };
    try { this.assertRole(agent); }
    catch (error) {
      if (!(error instanceof SubAgentDefinitionError) && !(error instanceof SubAgentRoleError) && !(error instanceof SubAgentDelegationError)) throw error;
      return { code: error.code, message: "SubAgent 的固定角色记录缺失或损坏，请新建 SubAgent 并保留旧记录供核实", reason: error.code };
    }
    if (work && agent.activeWorkId !== work.id && purpose === "receive") return { code: "invalid_state", message: "该 SubAgent 当前工作不是本工作：消息未投递", reason: "moved_work" };
    const activeTask = this.store.findActiveSubAgentTask(agent.id);
    if (agent.state !== "idle" || activeTask) return { code: "busy", message: `SubAgent 正忙或待核实（状态 ${agent.state}${activeTask ? `，活动任务 ${activeTask.id}` : ""}）：等当前任务结束后再委派`, reason: "busy" };
    return null;
  }

  private assertRole(agent: SubAgent, role?: string, hostReview = false): void {
    const definition = validateSubAgentRole(requireSubAgentDefinition(agent));
    if (definition.kind !== (hostReview ? "host_review" : "role")) throw new SubAgentDelegationError("forbidden", "宿主固定评审身份不能从普通委派继续或复用，请新建 SubAgent");
    if (role !== undefined && role !== definition.name) throw new SubAgentDelegationError("role_conflict", `SubAgent 已固定角色 ${definition.name}，请为角色 ${role} 新建 SubAgent`);
  }

  /**
   * 既有工作内的同键核实（继续 / 协作加入共用）：键按目标 Agent 的会话
   * （不同协作方的同键互相独立）。命中返回原任务，任务缺失即数据不一致
   * （不新建）；工作行引用的首次承接者缺失即数据不一致。
   */
  private dedupWorkTask(input: SubAgentDelegateInput, parentSession: Session): SubAgentDelegation | null {
    const work = this.store.getWorkDelegation(input.workId!);
    if (!work || work.parentSessionId !== parentSession.id) return null;
    const agent = this.store.getSubAgent(input.subAgentId ?? work.subAgentId);
    if (!agent) {
      if (!input.subAgentId) throw new SubAgentDelegationError("not_found", `工作 ${work.id} 缺少 SubAgent 记录`);
      return null; // 协作加入的目标缺失：由下方目标解析按 not_found 拒绝
    }
    const task = this.store.findTaskByRequest(agent.sessionId, subAgentTaskRequestId(work.id, input.key));
    if (!task) return null;
    this.assertRole(agent, input.role, Boolean(input.hostReview));
    if (task.submissionDigest !== taskSubmissionDigest(work.id, agent.id, input.paramsDigest)) {
      throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定参数不同的执行 ${task.id}`);
    }
    return { work, agent, task, created: false, newWork: false };
  }

  /** 首次键的查重：（父会话, 键）唯一；同参与原工作同任务返回，异参冲突。 */
  private dedupNewKey(input: SubAgentDelegateInput, parentSession: Session): SubAgentDelegation | null {
    const work = this.store.findWorkDelegation(parentSession.id, input.key);
    if (!work) return null;
    if (work.paramsDigest !== input.paramsDigest) {
      throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定参数不同的工作 ${work.id}`);
    }
    const agent = this.store.getSubAgent(work.subAgentId);
    const task = agent ? this.store.findTaskByRequest(agent.sessionId, subAgentTaskRequestId(work.id, input.key)) : null;
    if (!agent || !task) {
      throw new SubAgentDelegationError("not_found", `工作 ${work.id} 的执行记录不完整`);
    }
    this.assertRole(agent, input.role, Boolean(input.hostReview));
    return { work, agent, task, created: false, newWork: false };
  }

  /** dev 待读路径保存只读身份；受限模式取父工作区与授予范围交集并拒绝保护根。 */
  private prepareReadPaths(parent: Task, parentSession: Session, readPaths: string[]): SubAgentReadScope["paths"] {
    const out: SubAgentReadScope["paths"] = [];
    const seen = new Set<string>();
    for (const raw of readPaths) {
      if (typeof raw !== "string" || !raw.trim()) throw new SubAgentDelegationError("invalid_params", "待读路径不能为空");
      let real: string;
      try {
        // 相对路径按父会话工作目录解析
        real = fs.realpathSync(path.resolve(parentSession.cwdReal, raw));
      } catch {
        throw new SubAgentDelegationError("invalid_params", `待读路径不存在：${raw}`);
      }
      // 受限模式取交集：父工作区内，或父任务 grantedPaths 明确授予。
      const inWorkspace = grantCoversPath(parentSession.cwdReal, real);
      const granted = parent.grantedPaths.some((g) => {
        if (g.access !== "read" && g.access !== "read_write") return false;
        try {
          return grantCoversPath(fs.realpathSync(g.path), real);
        } catch {
          return false;
        }
      });
      if (parent.accessMode !== "full_access" && !inWorkspace && !granted) {
        throw new SubAgentDelegationError(
          "forbidden",
          `待读路径超出父工作区与已授予范围：${raw}（只允许父工作区内或父任务授予的只读路径）`,
        );
      }
      try {
        if (parent.accessMode !== "full_access") assertGrantNotProtected(real, this.deps.protectedRoots());
      } catch (err) {
        throw new SubAgentDelegationError("forbidden", (err as Error).message);
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const stat = fs.statSync(real);
      if (!this.workCopies.canRead(real, stat)) {
        throw new SubAgentDelegationError("forbidden", `实际执行身份不可读：${raw}（请核实当前账户的目录权限与 ACL）`);
      }
      out.push({ path: real, dev: stat.dev, ino: stat.ino, purpose: "委派时选定的只读资料" });
    }
    return out;
  }

  /** 子任务输入：宿主固定首行与边界说明（模型正文在其后，不能伪造首行）。 */
  private taskInput(
    workId: string,
    parent: Task,
    input: SubAgentDelegateInput,
    hasMaterials: boolean,
    paths: SubAgentReadScope["paths"],
    writeTarget?: WorkWriteTarget | null,
  ): string {
    // 宿主评审（issue 19）：固定首行与来源事件行，正文为 GitHubEvents.request；
    // 每次修订一项新工作、一个全新上下文，避免旧修订资料混进新 head 的核对
    if (input.hostReview) {
      const body = [
        "[SubAgent 委派 · GitHub PR 评审]",
        `工作 ${workId}（直接父任务 ${parent.id}，原样记录不作身份依据）。`,
        `来源事件 ${input.hostReview.sourceEventId}（GitHub PR 入站；评审只归属于该事件的修订，修订失效由宿主另行说明）。`,
        "你的工具只有 read / read_artifact 与宿主为本任务开放的只读 MCP：可以读取本目录与经 MCP 取得的 PR 资料；" +
          "不能修改文件、执行命令、写外部服务或委派下级。",
        "读不到所需资料（如无法经 MCP 取得 PR 信息）就明说能力范围，不要尝试其他手段。结束时的最终回答即评审草稿，宿主保存为任务产物并交回主 Agent。",
        `---\n${input.request}`,
      ].join("\n");
      if (body.length > INPUT_TEXT_CAP) {
        throw new SubAgentDelegationError("invalid_params", `委派正文（含边界说明）超过 ${INPUT_TEXT_CAP} 字符，请精简`);
      }
      return body;
    }
    const modify = writeTarget != null;
    const fullAccess = parent.accessMode === "full_access";
    const lines: string[] = [
      modify ? "[SubAgent 委派 · 工作区目标]" : "[SubAgent 委派 · 独立执行]",
      `工作 ${workId}（直接父任务 ${parent.id}，原样记录不作身份依据）。`,
      // 协作加入（issue 13）：向模型说明它进入了既有工作，可能已有其他协作方
      ...(input.subAgentId && input.workId
        ? ["本任务把你加入这项既有工作作为协作方：你保留自己的会话上下文，本工作可能还有其他 SubAgent 协作；只读路径与资料以本次为准。"]
        : []),
      // 复用承接新工作时向模型说明：保留的上下文是旧工作的，范围以本次为准
      ...(input.subAgentId && !input.workId ? ["本 SubAgent 此前承接过其他工作；只读路径与资料以本次为准，之前的范围不延续。"] : []),
    ];
    if (modify && writeTarget) {
      if (writeTarget.kind === "worktree") {
        lines.push(
          `目标：当前内容的 worktree 副本。独立副本工作目录 ${writeTarget.path}，` +
            `基线为委派时当前内容，包含已暂存、未暂存与非忽略的新文件（父工作区字节不变、副本脱离主会话共享锁）；` +
            `分支 ${writeTarget.branch}（宿主后台生成的本地 worktree，不提交、不推送）。`,
          "不要 git add/commit：改动留在工作树，由主 Agent 汇总相对捕获基线的新增改动。忽略文件和依赖目录没有复制；检查缺依赖时如实报告，由主 Agent 在获准副本内准备。",
          ...(fullAccess ? [] : ["共享 Git 目录只读，不能写 hooks/config；写入范围由受限执行环境约束，跨目录写由父会话目录占用串行。"]),
        );
      } else {
        lines.push(
          `目标：直接写入，与主会话按目录占用串行。写入根 ${writeTarget.path}；` +
            `后续任务在同一写入根上由占用串行，不会与父会话的当前执行互相覆盖。`,
        );
      }
    }
    lines.push(
      hasMaterials ? `资料：本目录 ${materialsFileFor(workId, input.key)} 是宿主选定的资料快照（快照正文不重新解析）。` : "资料：没有附带资料快照。",
      paths.length > 0 ? `只读路径（宿主钉定）：${paths.map((p) => p.path).join("、")}` : "只读路径：无。",
      `访问模式：${fullAccess ? "完全访问，使用启动账户已有权限，已开放工具无需逐次审批" : parent.accessMode === "auto-review" ? "自动审查，使用受限执行环境与原审批规则" : "请求确认，使用受限执行环境与原审批规则"}；权限由宿主取本次发起任务，不由正文决定。`,
      "使用本任务实际提供的工具完成工作，个人业务与外部服务须沿宿主核实的来源资格；不能再委派下级或直接与拥有者交互。没有代码目标时只在独立目录处理获准资料；需要修改代码请由主 Agent 指定目标。",
      "同项工作的协作：用 subagent_message 向主 Agent 或当前承接本工作的其他 SubAgent 发送有来源的消息（彼此上下文不自动共享）；" +
        "协作消息会作为本工作的新任务送达你。消息不扩大任何一方的工具与资料范围。",
      ...(modify
        ? [
            "结束目标工作前在副本内完成与该改动相关的检查（类型、测试、构建等可见命令），并在结论里如实报告" +
              "检查命令与结果，或写明尚未验证的部分——主 Agent 汇总改动时依据你的报告与另行的验证决定去留。",
          ]
        : []),
      "读不到所需资料就明说能力范围并请主 Agent 补充，不要尝试其他手段。结束时直接给出结论，结论会回到主 Agent。",
      `---\n${input.request}`,
    );
    const body = lines.join("\n");
    // 与旧委派同口径：宿主模板 + 请求合计超过 cap 即拒绝（不截断）
    if (body.length > INPUT_TEXT_CAP) {
      throw new SubAgentDelegationError("invalid_params", `委派正文（含边界说明）超过 ${INPUT_TEXT_CAP} 字符，请精简`);
    }
    return body;
  }
}
