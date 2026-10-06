/**
 * 通用 SubAgent 委派（agent-direction issue 11，ADR 0020；issue 12 继续/复用/
 * 关闭；issue 14 整项取消；issue 16 修改委派——worktree 隔离与非 Git 串行；
 * issue 17 改动汇总并开放 main 的修改委派；issue 19 宿主固定评审）：
 * 集中登记工作委托、动态 SubAgent 身份与每次执行任务。
 *
 * 边界：
 * - 首版分析能力固定为只读（read / read_artifact）；模型只给正文、幂等键、
 *   可选既有 workId / subAgentId 与选定资料（main 的资料引用 / dev 的待读路径）；
 *   目标身份、独立目录、confirm 模式与截止时间由本模块固定；
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

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Store } from "../core/store.ts";
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
} from "../core/types.ts";
import { randomId } from "../core/types.ts";
import { runsInPlanMode } from "../agent/plan-mode.ts";
import type { SourceResolver } from "../agent/scheduler-tools.ts";
import type { SourceRef } from "../scheduler/store.ts";
import type { WorkerLauncher } from "../agent/execution/launchers.ts";
import { assertGrantNotProtected } from "../agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "../core/worktree.ts";
import type { ParentDelivery } from "./parent-delivery.ts";

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

/** bash 单引号包裹（worktree 创建与改动汇总的容器命令共用）。 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 共享 Git 目录超出父仓库目录树时的补挂（创建副本与汇总同一取舍）。 */
function worktreeExtraGrants(repoRootReal: string, commonGitDir: string, purpose: string): { path: string; access: "read_write"; purpose: string }[] | null {
  return grantCoversPath(repoRootReal, commonGitDir) ? null : [{ path: commonGitDir, access: "read_write", purpose }];
}

/** 工作内每次执行的请求键（与 (session_id, request_id) 唯一约束配合）。 */
export function subAgentTaskRequestId(workId: string, key: string): string {
  return `sdelegate:${workId}:${key}`;
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
  /** 拥有者发起的当前主任务（直接父任务；摘要不覆盖它，跨轮次重放不误冲突）。 */
  parentTaskId: string;
  key: string;
  request: string;
  /** 既有工作（沿原工作增加新的分析执行）；null = 新工作。 */
  workId?: string | null;
  /**
   * 复用既有空闲 SubAgent 承接新工作（issue 12）；与 workId 同现 = 协作加入
   * （issue 13）：把该空闲 Agent 拉入既有工作登记一次执行任务（任务关联列指向
   * 协作方，工作行保持首次承接者；修改工作与宿主评审工作不接受协作加入）。
   * 两种情况都保留该 Agent 的独立会话上下文；读范围与资料按本次任务重新钉定。
   */
  subAgentId?: string | null;
  /** 委派模式（issue 16）；缺省 analyze。modify 需要 target 且不配子材料/读范围。 */
  mode?: "analyze" | "modify";
  /** 委派写入目标（仅 modify；相对父工作区或可解析到父工作区内的路径）。 */
  target?: string | null;
  /** main 选定资料（原样引用对象；重复委派不重新解析）。 */
  materials?: Record<string, unknown>[] | null;
  /** dev 待读取路径（宿主核实交集后钉定只读范围）。 */
  readPaths?: string[] | null;
  /** 工具计算的规范化参数摘要（覆盖 request/key/workId/subAgentId/materials/readPaths；modify 另加 mode/target）。 */
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
  /** 子工作目录根（保护根之外，如 agent-work/sub-agents/）。 */
  workRoot: string;
  /** 修改委派的 worktree 副本根（保护根之外，如 agent-work/worktrees/）。 */
  worktreeRoot: string;
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
  /**
   * 实际执行身份的 uid/gid（容器后端）；null = 以后台账户执行（权限位检查
   * 代替 identity 可达性核实）。用于准备时核实执行身份能读选定资料——不能用
   * 后台 UID 读通代替执行身份验证。
   */
  executionReaderIdentity?(): { uid: number; gid: number } | null;
  /**
   * 在确认容器内执行一条宿主固定的 bash（issue 16 worktree 创建；issue 17 改动
   * 汇总）。workspace 是工作区；copyDir 是作读写挂载的副本目录（容器内同路径）。
   * extraGrants 是 workspace 装不下的额外挂载（如父仓库本身是 worktree 时的
   * 共享 Git 目录，按读写挂在容器外位置）。返回 gh.runBash Git 结果；宿主永不
   * 执行 git。
   */
  createWorktreeInContainer?(input: {
    workspace: string;
    copyDir: string;
    branch: string;
    command: string;
    extraGrants?: { path: string; access: "read" | "read_write"; purpose: string }[] | null;
  }): Promise<{ isError: boolean; errorMessage?: string; content: string }>;
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

/** 汇总事件里文件清单的上限（超出只计数、不列名）。 */
const INTEGRATE_FILE_LIST_CAP = 64;

export class SubAgentDelegationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class SubAgentManager {
  private readonly deps: SubAgentManagerDeps;

  constructor(deps: SubAgentManagerDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
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

  /** 恢复事务内调用：从未启动的普通委派中断，宿主评审保持排队。 */
  recoverQueuedTasks(): string[] {
    const ids: string[] = [];
    for (const task of this.store.listQueuedSubAgentTasks()) {
      if (!this.store.transitionTask(task.id, ["queued"], "interrupted", {
        interruptReason: "backend_restart", endedAt: new Date().toISOString(),
      })) continue;
      this.store.appendEvent({
        type: "task.interrupted", taskId: task.id, sessionId: task.sessionId,
        reason: "backend_restart", cancelRequested: task.cancelRequested, effectUnknown: task.effectUnknown,
      }, { taskId: task.id, sessionId: task.sessionId });
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
      try { await this.deps.resumeQueue(agent.sessionId); }
      catch (err) { this.log(`恢复 SubAgent ${agent.id} 队列失败：${(err as Error).message}`); }
    }
  }

  private log(message: string): void {
    process.stderr.write(`[ruukoto:subagents] ${message}\n`);
  }

  /**
   * 非阻塞委派：登记后立即返回。查重先于资料解析与限额；新请求先异步准备
   * 再在一个同步事务内重核并登记，提交后 kick 子会话。
   */
  async delegate(input: SubAgentDelegateInput): Promise<SubAgentDelegation> {
    const parent = this.store.getTask(input.parentTaskId);
    if (!parent) throw new SubAgentDelegationError("not_found", `父任务不存在：${input.parentTaskId}`);
    const parentSession = this.store.getSession(parent.sessionId);
    if (!parentSession) throw new SubAgentDelegationError("not_found", `父任务会话不存在：${parent.sessionId}`);
    // 父会话按身份判定（架构工单 08）：只有普通开发会话与 main 会话可以委派，两种 mode 同一口径
    const parentKind = this.store.getSessionIdentity(parent.sessionId)?.kind;
    if (parentKind === "subagent") throw new SubAgentDelegationError("forbidden", "SubAgent 不能委派下级（只有普通开发会话或 main 可以登记工作委托）");
    if (parentKind !== "dev" && parentKind !== "main") throw new SubAgentDelegationError("forbidden", "只有普通开发会话或 main 可以登记工作委托（已退役归档会话不能委派）");
    if (!input.request.trim()) throw new SubAgentDelegationError("invalid_params", "委派正文不能为空");
    const mode = input.mode ?? "analyze";
    if (runsInPlanMode(parent, (id) => this.store.getTask(id)) &&
        (mode === "modify" || (input.workId && this.store.getWorkDelegation(input.workId)?.writeTarget))) {
      throw new SubAgentDelegationError("forbidden", "计划模式不能发起修改委派或继续修改工作");
    }
    if (mode === "modify") {
      if (input.workId) {
        // 继续委派沿用工作原有模式，不能指定 mode——凡 mode=modify 与 workId 同现，
        // 都是“把只读工作升级为写入”或“切换已钉定写入目标”的越界请求
        if (this.store.getWorkDelegation(input.workId)?.writeTarget) {
          throw new SubAgentDelegationError("invalid_params", "work_id 沿用工作原有模式，不能指定 mode");
        }
        throw new SubAgentDelegationError("invalid_state", "只读分析工作不能升级为写入（请为修改新建一项工作）");
      }
      if (input.target == null) throw new SubAgentDelegationError("invalid_params", "mode=modify 需要 target");
    }
    if (input.workId && input.mode !== undefined) {
      throw new SubAgentDelegationError("invalid_params", "work_id 沿用工作原有模式，不能指定 mode");
    }
    if (mode === "analyze" && input.target != null) {
      throw new SubAgentDelegationError("invalid_params", "target 仅 mode=modify 使用");
    }
    if (
      input.hostReview &&
      (input.workId || input.subAgentId || mode === "modify" || input.target != null || (input.materials?.length ?? 0) > 0 || (input.readPaths?.length ?? 0) > 0)
    ) {
      throw new SubAgentDelegationError("invalid_params", "宿主评审不携带复用/修改/资料参数（每个入站修订一项新工作、一个新 SubAgent）");
    }

    // —— 查重先：重复委派不重新解析可能已变化的资料（同键同参的重放即使目标
    // Agent 已关闭或忙碌也返回原记录，不新建任务）——
    const hit = input.workId ? this.dedupWorkTask(input, parentSession) : this.dedupNewKey(input, parentSession);
    if (hit) return hit;

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
    }
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
    // 受限执行入口与模型配置预检（缺后端/门闩明确失败，不回退）
    this.deps.launcherFor("confirm");
    const selection = this.deps.defaultModelSelection();
    const check = await this.deps.resolveSelection(selection);
    const deadline = new Date(Date.parse(parent.startedAt ?? parent.createdAt) + SUBAGENT_LIMITS.deadlineMs).toISOString();

    // —— 修改委派（issue 16）：写入目标在事务外准备（worktree 容器创建或
    // 非 Git 写预检），事务内钉定；继续委派沿用工作原有 writeTarget ——
    let writeTarget: WorkWriteTarget | null = null;
    if (mode === "modify") {
      if (reusedWork) {
        // 继续委派：沿用工作原有 writeTarget（首次钉定）；只读工作不能升级为写入
        writeTarget = reusedWork.writeTarget;
        if (!writeTarget) {
          throw new SubAgentDelegationError("invalid_state", `工作 ${reusedWork.id} 是只读分析工作，不能升级为写入`);
        }
      } else {
        writeTarget = await this.prepareWriteTarget(parent, parentSession, input, workId);
      }
    }

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
        const resolved = this.deps.sources.resolve(parentSession.projectId, input.materials);
        sourceRefs = resolved.refs;
        snapshotFile = path.join(workDir, materialsFileFor(workId, input.key));
        fs.writeFileSync(snapshotFile, resolved.text, { encoding: "utf8", mode: 0o600 });
      } else if (input.readPaths && input.readPaths.length > 0) {
        scopePaths = this.prepareReadPaths(parent, parentSession, input.readPaths);
      }
      inputText = this.taskInput(workId, parent, input, (input.materials?.length ?? 0) > 0, scopePaths, writeTarget);
    } catch (err) {
      cleanup();
      throw err;
    }

    const readScope: SubAgentReadScope = { paths: scopePaths, sourceRefs };
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
        const racedTask = agentNow ? this.store.findTaskByRequest(agentNow.sessionId, requestId) : null;
        if (racedWork && agentNow && racedTask) {
          if (racedWork.parentSessionId !== parentSession.id || racedTask.submissionDigest !== submissionDigest) {
            throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定参数不同的记录`);
          }
          return { work: racedWork, agent: agentNow, task: racedTask, created: false, newWork: false };
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
        const allRefs: SourceRef[] = agentNow
          ? this.store.listTasksBySession(agentNow.sessionId).flatMap((t) => (t.readScope?.sourceRefs ?? []) as SourceRef[])
          : [];
        allRefs.push(...(readScope.sourceRefs as SourceRef[]));
        if (allRefs.length > 0) {
          const problem = this.deps.sources.verify(parentSession.projectId, allRefs);
          if (problem) {
            throw new SubAgentDelegationError("forbidden", `资料授权已在提交前变化，拒绝登记：${problem}`);
          }
        }
        const parentNow = this.store.getTask(parent.id);
        if (!parentNow || parentNow.sessionId !== parentSession.id) {
          throw new SubAgentDelegationError("forbidden", "父任务归属已变化，拒绝登记");
        }
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
          accessMode: "confirm",
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
          const ok = this.store.transitionTask(t.id, ["queued"], "canceled", { errorMessage: "work_canceled", endedAt: now });
          if (ok) {
            this.store.appendEvent(
              { type: "task.canceled", taskId: t.id, sessionId: t.sessionId },
              { taskId: t.id, sessionId: t.sessionId },
            );
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
    const prepared = await this.prepareMessageDelivery(initial.work, initial.target);
    const kicks: string[] = [];
    const out = this.store.withTx(() => {
      const context = this.messageContext(input);
      if ("hit" in context) return context.hit;
      const { work, sender, target, text } = context;
      this.checkMessageDelivery(work, target, prepared);
      const msg: SubAgentMessage = {
        id: randomId("smsg"),
        workId: work.id,
        parentSessionId: work.parentSessionId,
        fromSubAgentId: sender?.id ?? null,
        fromTaskId: input.senderTaskId,
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
    { hit: SubAgentMessageResult } | { work: WorkDelegation; sender: SubAgent | null; target: SubAgent | null; text: string } {
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
    return { work, sender, target, text };
  }

  /** 只有真正需要建执行任务的消息才需要模型和受限执行入口。 */
  private messageSelection(work: WorkDelegation, target: SubAgent | null): ModelSelection | null {
    if (target) return this.deps.defaultModelSelection();
    const identity = this.store.getSessionIdentity(work.parentSessionId);
    return identity?.kind === "main" ? identity.role.modelSelection ?? this.deps.defaultModelSelection() : null;
  }

  private async prepareMessageDelivery(work: WorkDelegation, target: SubAgent | null): Promise<{ selection: ModelSelection; check: () => void } | null> {
    const selection = this.messageSelection(work, target);
    if (!selection) return null;
    this.deps.launcherFor("confirm");
    const check = await this.deps.resolveSelection(selection);
    return { selection, check };
  }

  private checkMessageDelivery(work: WorkDelegation, target: SubAgent | null, prepared: { selection: ModelSelection; check: () => void } | null): void {
    if (!isDeepStrictEqual(this.messageSelection(work, target), prepared?.selection ?? null)) {
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
        const prepared = await this.prepareMessageDelivery(initial.work, initial.target);
        const kicks: string[] = [];
        this.store.withTx(() => {
          const current = this.pendingMessageContext(msg);
          if (!current) return;
          this.checkMessageDelivery(current.work, current.target, prepared);
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
    const work = this.store.getWorkDelegation(msg.workId);
    if (!work || work.canceledAt) {
      this.dropMessage(msg, work ? "work_canceled" : "work_missing");
      return null;
    }
    if (!msg.toSubAgentId) {
      return this.store.getSessionIdentity(work.parentSessionId)?.kind === "main" ? { work, target: null } : null;
    }
    const target = this.store.getSubAgent(msg.toSubAgentId);
    if (!target) { this.dropMessage(msg, "agent_missing"); return null; }
    const problem = this.eligibility(target, work.parentSessionId, work, "receive");
    if (problem) {
      if (problem.code !== "busy") this.dropMessage(msg, problem.reason);
      return null;
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
   * 投递为接收方的本工作执行任务（确认模式；读范围沿用其在本工作最近一次
   * 任务的钉定——消息不扩大任何范围）。登记、标记、占用状态与事件同一事务。
   */
  private deliverAsTask(msg: SubAgentMessage, work: WorkDelegation, agent: SubAgent, selection: ModelSelection, kicks: string[]): void {
    const { task } = this.store.insertQueuedTask({
      sessionId: agent.sessionId,
      requestId: `smsg:${msg.id}`,
      input: this.messageTaskInput(msg, work),
      accessMode: "confirm",
      modelSelection: selection,
      submissionDigest: createHash("sha256").update(JSON.stringify({ kind: "smsg", messageId: msg.id })).digest("hex"),
      parentTaskId: msg.fromTaskId,
      deadline: new Date(Date.now() + SUBAGENT_LIMITS.deadlineMs).toISOString(),
      workId: work.id,
      subAgentId: agent.id,
      readScope: this.store.listTasksBySession(agent.sessionId).filter((t) => t.workId === work.id).at(-1)?.readScope ?? null,
    });
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
      "这是同项工作协作方发来的消息，作为本工作的一次执行任务送达：不扩大你的资料范围与工具权限（与本工作其余执行一致）。",
      "要回复或向同项工作的协作方补充，用 subagent_message（work_id 用本工作；省略 to_sub_agent_id 发给主 Agent）；结束时的最终回答仍作为本工作结果回到主 Agent。",
      `---\n${msg.body}`,
    ].join("\n");
    if (body.length > INPUT_TEXT_CAP) {
      throw new SubAgentDelegationError("invalid_params", `消息正文（含来源说明）超过 ${INPUT_TEXT_CAP} 字符，请精简`);
    }
    return body;
  }

  /**
   * 改动汇总（agent-direction issue 17）：把 worktree 副本相对基线的完整差异
   * 套用到父工作区的待提交区，不代提交、不强制覆盖。
   *
   * - 只按工作 id 取首次钉定的写入目标——Agent 复用承接新工作后，汇总旧工作
   *   仍只落旧工作自己的副本（新工作另建副本，互不相干）；
   * - 套用前核实：工作有活动任务拒绝（busy）；副本 realpath/dev/ino 与 `.git`
   *   指向逐项复核（worktree_gone，不自动重建、不凭旧记录套用）；原工作区的
   *   仓库根仍在父会话工作区内且可读；
   * - 容器命令（宿主固定，宿主永不执行 git）：副本内 `add -N`（含未跟踪）
   *   → 对基线取完整二进制 diff + numstat → 父仓库 `apply --check` 预检，
   *   能干净套用才写入（git apply 预检失败不落任何字节）——父工作区同文件的
   *   本地改动不被覆盖；完整差异已在工作区时按幂等返回 already，不重复登记；
   * - 冲突：零写入，父工作区原改动与副本成果都保留，错误点名冲突文件；
   * - 套用时登记 `work_delegation.integrated`（分支/基线/父 HEAD/文件清单与
   *   统计），取消过的工作与已关闭的 SubAgent 不拦汇总（取消/关闭本就不删
   *   副本，汇总正是未汇总成果的可找回路径）；
   * - 非 Git 直接写入工作没有副本：改动本就在父工作区就地落盘，如实告知。
   *
   * ponytail: 套用的是「副本此刻对基线的全差异」——汇总后又继续委派产生新
   * 改动时，再次汇总会命中冲突（已套用的 hunks 挡路），此时按冲突如实报告
   * 双方保留，由主 Agent 用自己的工具核对差异处理；不引入增量汇总状态。
   * 登记 busy 检查与容器套用之间登记的新执行可能让副本在套用后继续变化：
   * 副本原样保留、事件钉定基线与文件清单，事后可核对，不加锁。
   */
  async integrate(input: { workId: string; parentTaskId: string; parentSessionId: string }): Promise<WorkIntegration> {
    const work = this.store.getWorkDelegation(input.workId);
    if (!work || work.parentSessionId !== input.parentSessionId) {
      throw new SubAgentDelegationError("not_found", `工作委托不存在或不属于本会话：${input.workId}`);
    }
    const target = work.writeTarget;
    if (!target) {
      throw new SubAgentDelegationError("invalid_state", `工作 ${work.id} 是只读分析工作：没有写入目标，没有副本可汇总`);
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
    // 副本状态核实（与继续委派同一判定）；原工作区状态：仓库根仍在父工作区内
    // 且 .git 可读（被替换/移走明确拒绝，不凭钉定记录套用）
    this.assertWorktreeCopy(work, target, "无法汇总");
    let repoRootReal: string;
    try {
      repoRootReal = fs.realpathSync(target.repoRoot);
      fs.lstatSync(path.join(repoRootReal, ".git"));
    } catch {
      throw new SubAgentDelegationError("worktree_gone", `原工作区仓库根已不存在或不可读，无法汇总（路径 ${target.repoRoot}）`);
    }
    if (repoRootReal !== target.repoRoot || !grantCoversPath(parentSession.cwdReal, repoRootReal)) {
      throw new SubAgentDelegationError("forbidden", `原工作区仓库根已不在父会话工作区内，无法汇总（路径 ${target.repoRoot}）`);
    }
    if (!this.deps.createWorktreeInContainer) {
      throw new SubAgentDelegationError("execution_unavailable", "宿主缺少 worktree 容器入口（执行边界不可用，不回退）");
    }
    const dst = target.path;
    const repo = repoRootReal;
    const copyDirReal = (() => {
      try {
        return fs.realpathSync(dst);
      } catch {
        return dst;
      }
    })();
    // 与 issue 16 创建同一硬化口径：关 fsmonitor（仓库 config 可被写入）、hooks 走
    // /dev/null；apply --check 预检成功才写入，预检失败零写入。apply --check 之后、
    // apply 落盘之前崩溃会留下部分套用：由 git apply 原子性之外的真实窗口，现场
    // 可由父工作区 git status 与保留的副本核对（不自动重放，不登记事件）。
    const command =
      "set -eu\n" +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false -c core.hooksPath=/dev/null add -N --all\n` +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false diff --binary --no-ext-diff -M ${shq(target.baseCommit)} > /tmp/ruukoto-integrate.patch\n` +
      `git -C ${shq(copyDirReal)} -c core.fsmonitor=false diff --numstat --no-ext-diff -M ${shq(target.baseCommit)} > /tmp/ruukoto-integrate.numstat\n` +
      `if [ ! -s /tmp/ruukoto-integrate.patch ]; then echo RUUKOTO_STATE=empty; exit 0; fi\n` +
      `head=$(git -C ${shq(repo)} rev-parse HEAD 2>/dev/null | head -n1 || true)\n` +
      `if git -C ${shq(repo)} apply --check /tmp/ruukoto-integrate.patch 2>/tmp/ruukoto-integrate.err; then\n` +
      `  git -C ${shq(repo)} apply /tmp/ruukoto-integrate.patch\n` +
      `  echo RUUKOTO_STATE=applied\n` +
      `elif git -C ${shq(repo)} apply --check --reverse /tmp/ruukoto-integrate.patch 2>/dev/null; then\n` +
      `  echo RUUKOTO_STATE=already\n` +
      `else\n` +
      `  echo RUUKOTO_STATE=conflict\n` +
      `  cat /tmp/ruukoto-integrate.err\n` +
      `fi\n` +
      `echo "RUUKOTO_HEAD=$head"\n` +
      `echo "RUUKOTO_PATCH_BYTES=$(wc -c < /tmp/ruukoto-integrate.patch | tr -d ' ')"\n` +
      `cat /tmp/ruukoto-integrate.numstat\n`;
    // 共享 Git 目录超出父仓库 cwd 的情况（父仓库本身是 worktree）：索引与对象
    // 写在共享目录里，需要它的读写挂载（钉定记录已核实它在父工作区内）
    const extraGrants = worktreeExtraGrants(repo, target.commonGitDir, "worktree 副本汇总的共享 Git 目录（issue 17）");
    const result = await this.deps.createWorktreeInContainer({
      workspace: repo,
      copyDir: copyDirReal,
      branch: target.branch,
      command,
      extraGrants,
    });
    if (result.isError) {
      const label = (result.errorMessage ?? result.content).slice(0, 1000);
      throw new SubAgentDelegationError("integrate_failed", `改动汇总失败（工作 ${work.id}，副本 ${dst}）：${label}；父工作区与副本现场保留供核查`);
    }
    const parsed = this.parseIntegrationOutput(result.content);
    if (parsed.state === "conflict") {
      throw new SubAgentDelegationError(
        "integrate_conflict",
        `汇总冲突（工作 ${work.id}）：副本差异无法干净套用，父工作区同文件已有本地改动或此前已部分汇总。` +
          `父工作区原改动与副本成果 ${dst} 都保留，未写入任何字节。冲突明细：${parsed.detail}` +
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
   * 解析汇总容器输出：标记行（RUUKOTO_STATE/HEAD/PATCH_BYTES）与 numstat 行；
   * conflict 时把 apply 的报错正文作为明细带回（截断）。
   */
  private parseIntegrationOutput(content: string): {
    state: "applied" | "already" | "empty" | "conflict";
    detail: string;
    parentHead: string | null;
    patchBytes: number;
    filesChanged: number;
    insertions: number;
    deletions: number;
    files: string[];
  } {
    const stateM = /^RUUKOTO_STATE=(applied|already|empty|conflict)$/m.exec(content);
    const state = (stateM?.[1] ?? "conflict") as "applied" | "already" | "empty" | "conflict";
    const headM = /^RUUKOTO_HEAD=([0-9a-f]{40})$/m.exec(content);
    const bytesM = /^RUUKOTO_PATCH_BYTES=(\d+)$/m.exec(content);
    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    const files: string[] = [];
    for (const line of content.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
      if (!m) continue;
      filesChanged += 1;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
      files.push(m[3]!.trim());
    }
    // 冲突明细：state 标记之后、HEAD 标记之前的报错正文（截断）
    let detail = "";
    if (state === "conflict" && stateM) {
      const rest = content.slice(stateM.index + stateM[0].length);
      const cut = rest.search(/^RUUKOTO_HEAD=/m);
      detail = (cut >= 0 ? rest.slice(0, cut) : rest).trim().slice(0, 2000);
    }
    return {
      state,
      detail,
      parentHead: headM?.[1] ?? null,
      patchBytes: bytesM ? Number(bytesM[1]) : 0,
      filesChanged,
      insertions,
      deletions,
      files,
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
      this.assertWorktreeCopy(work!, target, "请新建委派");
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
    if (this.store.hasInboundSourcedSubAgentTask(agent.id)) return { code: "forbidden", message: "该 SubAgent 的工作源自入站事件（上下文含不可信外部资料）：不能复用或续派", reason: "inbound_review" };
    if (work && agent.activeWorkId !== work.id && purpose === "receive") return { code: "invalid_state", message: "该 SubAgent 当前工作不是本工作：消息未投递", reason: "moved_work" };
    const activeTask = this.store.findActiveSubAgentTask(agent.id);
    if (agent.state !== "idle" || activeTask) return { code: "busy", message: `SubAgent 正忙或待核实（状态 ${agent.state}${activeTask ? `，活动任务 ${activeTask.id}` : ""}）：等当前任务结束后再委派`, reason: "busy" };
    return null;
  }

  /**
   * worktree 副本状态核实（issue 16 继续委派与 issue 17 汇总共用大门）：目录
   * realpath/dev/ino 与钉定一致、`.git` 指向的 gitdir 未变化；被替换或消失即
   * 明确失败，不自动重建、不凭旧记录套用。
   */
  private assertWorktreeCopy(work: WorkDelegation, target: Extract<WorkWriteTarget, { kind: "worktree" }>, hint: string): void {
    try {
      const tReal = fs.realpathSync(target.path);
      const tStat = fs.statSync(tReal);
      if (tReal !== target.path || tStat.dev !== target.dev || tStat.ino !== target.ino) {
        throw new SubAgentDelegationError("worktree_gone", `工作 ${work.id} 的 worktree 已被替换，${hint}（路径 ${target.path}）`);
      }
      const gitFile = path.join(tReal, ".git");
      const content = fs.readFileSync(gitFile, "utf8");
      const m = /^gitdir:\s*(.+)\s*$/m.exec(content);
      const resolved = m ? path.resolve(tReal, m[1]!.trim()) : null;
      if (!resolved || !this.sameRealpath(resolved, target.gitdir)) {
        throw new SubAgentDelegationError("worktree_gone", `工作 ${work.id} 的 .git 指向已变化，${hint}（路径 ${target.path}）`);
      }
    } catch (err) {
      if (err instanceof SubAgentDelegationError) throw err;
      throw new SubAgentDelegationError("worktree_gone", `工作 ${work.id} 的 worktree 已不存在，${hint}（路径 ${target.path}）`);
    }
  }

  /** realpath 比较（容错：一方缺失时为 false）。 */
  private sameRealpath(a: string, b: string): boolean {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  }

  /**
   * 仓库根的纯文件系统探查（issue 16）：自目标向上找第一个含 `.git` 的目录；
   * `.git` 可以是目录（普通仓库）或文件（worktree 指针）。范围不超过父工作区
   * 边界；宿主不执行 git。
   */
  private findRepoRoot(startReal: string, workspaceReal: string): string | null {
    let dir = startReal;
    for (;;) {
      const gitPath = path.join(dir, ".git");
      try {
        const st = fs.lstatSync(gitPath);
        if (st.isDirectory() || st.isFile()) return dir;
      } catch {
        // 本层无 .git，继续向上
      }
      if (dir === workspaceReal) return null;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /**
   * 定位 <repoRoot> 的共享 Git 目录：普通仓库 = `<repoRoot>/.git`；worktree
   * 指针文件复用 core/worktree.ts 的共享解析。返回 null = 不是有效仓库
   * （无 .git 或无法解析）。
   */
  private resolveCommonGitDir(repoRoot: string): string | null {
    const gitPath = path.join(repoRoot, ".git");
    let st: fs.Stats;
    try {
      st = fs.lstatSync(gitPath);
    } catch {
      return null;
    }
    if (st.isDirectory()) {
      try {
        return fs.realpathSync(gitPath);
      } catch {
        return null;
      }
    }
    if (!st.isFile()) return null;
    return resolveWorktreeCommonGitDir(repoRoot);
  }

  /**
   * 修改委派的写入目标准备（issue 16，事务外）：解析 target 到父工作区内 →
   * 探查仓库根 → Git 目标在受限容器内创建宿主 worktree（宿主永不执行 git）；
   * 非 Git 目录预检执行身份能写（权限位思路镜像 executionCanRead）。
   * 任何失败（不可达/越界/容器失败/权限不足）都在登记前拒绝，不留半成品。
   */
  private async prepareWriteTarget(
    parent: Task,
    parentSession: Session,
    input: SubAgentDelegateInput,
    workId: string,
  ): Promise<WorkWriteTarget> {
    const raw = input.target;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new SubAgentDelegationError("invalid_params", "mode=modify 需要非空 target");
    }
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(parentSession.cwdReal, raw));
    } catch {
      throw new SubAgentDelegationError("invalid_params", `修改目标不存在：${raw}`);
    }
    // 边界：父工作区内（委派目标的注入防线）；子工作区、共享 Git 目录与
    // 保护根由下方逐段守门
    if (!grantCoversPath(parentSession.cwdReal, real)) {
      throw new SubAgentDelegationError("forbidden", `修改目标必须位于父工作区内：${raw}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new SubAgentDelegationError("invalid_params", `修改目标不可读：${raw}`);
    }
    if (!stat.isDirectory()) {
      throw new SubAgentDelegationError("invalid_params", `修改目标必须是目录：${raw}`);
    }
    try {
      assertGrantNotProtected(real, this.deps.protectedRoots());
    } catch (err) {
      throw new SubAgentDelegationError("forbidden", (err as Error).message);
    }
    // worktree 副本根守门：副本目标是宿主管控区，不允许把写入目标指回其中
    const copyRoot = path.resolve(this.deps.worktreeRoot);
    if (grantCoversPath(copyRoot, real) || grantCoversPath(real, copyRoot)) {
      throw new SubAgentDelegationError("forbidden", "修改目标不能位于宿主 worktree 副本根内");
    }

    const repoRoot = this.findRepoRoot(real, parentSession.cwdReal);
    if (!repoRoot) {
      // —— 非 Git 目标：直接写入，与父会话按目录占用串行 ——
      if (!this.executionCanWrite(real, stat)) {
        throw new SubAgentDelegationError("forbidden", `实际执行身份不可写：${raw}（权限位不满足容器/执行账户身份）`);
      }
      return { kind: "direct", path: real, dev: stat.dev, ino: stat.ino };
    }

    // —— Git 目标：worktree 隔离副本（宿主后台用受限容器创建；父工作区字节不变）——
    const commonGitDir = this.resolveCommonGitDir(repoRoot);
    if (!commonGitDir) {
      throw new SubAgentDelegationError("invalid_params", `无法定位仓库的共享 Git 目录：${raw}`);
    }
    // 守门：共享 Git 元数据可写 = 子任务经 hooks/core.fsmonitor 逃出边界，
    // 要求必须钉定在父工作区内（元数据与工作树同一归属链）。
    if (!grantCoversPath(parentSession.cwdReal, commonGitDir)) {
      throw new SubAgentDelegationError(
        "forbidden",
        `共享 Git 目录不在父工作区内：${commonGitDir}（只允许父工作区持有其元数据）`,
      );
    }
    // 读预检：容器读子树的权限位按执行身份核实（不用后台 UID 读通代替执行身份）
    if (!this.executionCanRead(real, stat)) {
      throw new SubAgentDelegationError("forbidden", `实际执行身份不可读仓库目录：${raw}（权限位不满足容器/执行账户身份）`);
    }
    // 写预检：worktree add 会写共享 Git 元数据（worktrees/<name>、refs），副本自身
    // 是宿主在副本根内自建，不对 real 核写位；这里按执行身份核共享目录可写，早拒
    // 优于容器内尾失败（失败会保留现场）
    if (!this.executionCanWrite(commonGitDir, fs.statSync(commonGitDir))) {
      throw new SubAgentDelegationError("forbidden", `实际执行身份不可写共享 Git 目录：${commonGitDir}（权限位不满足容器/执行账户身份）`);
    }
    const branch = `ruukoto/work-${workId}`;
    const copyDir = path.join(this.deps.worktreeRoot, workId);
    // 副本目录归属副本根（不在父工作区内、不在保护根内）；副本根本身在
    // protectedRoots() / dataDir 之外——创建前逐段守门
    fs.mkdirSync(copyRoot, { recursive: true, mode: 0o700 });
    assertGrantNotProtected(copyDir, this.deps.protectedRoots());
    if (fs.existsSync(copyDir)) {
      // 非空 = 此前失败留下的真实现场：不自动认领/覆盖；空目录只在本次流程内出现
      // （下方预建），不存在“别人的空副本目录”稳定来源
      if (fs.readdirSync(copyDir).length > 0) {
        throw new SubAgentDelegationError("invalid_state", `副本目录已存在：${copyDir}（不自动认领/覆盖残留副本）`);
      }
    } else {
      // 挂载源必须在容器启动前存在于宿主（否则 Docker 会以 root 自动创建该路径，
      // 容器内 uid 写 .git 被拒）；git worktree add 接受现成的空目录
      fs.mkdirSync(copyDir, { mode: 0o700 });
    }
    if (!this.deps.createWorktreeInContainer) {
      throw new SubAgentDelegationError("execution_unavailable", "宿主缺少 worktree 容器创建入口（执行边界不可用，不回退）");
    }
    // git 把副本路径原样写进 <commonGitDir>/worktrees/<name>/gitdir，之后 git 会
    // 按该字串回核；macOS 上 TMPDIR 走 /var → /private/var 符号链接，字串与
    // realpath 不一致即“not a git repository”。命令与挂载统一用 realpath
    const copyDirReal = fs.realpathSync(copyDir);
    // core.fsmonitor=false：仓库 config 里被植入的 fsmonitor 不得在宿主选择的这条
    // 固定命令里参与执行（其 stderr 噪声也会污染基线输出解析）；hooks 已用 /dev/null
    const command =
      `set -eu; ` +
      `base=$(git -c core.fsmonitor=false rev-parse --verify HEAD); ` +
      `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add -q -b ${shq(branch)} ${shq(copyDirReal)} "$base"; ` +
      `printf '%s' "$base"`;
    // 父仓库本身是 worktree（共享 Git 目录在仓库根之外）：创建容器需要把它按
    // 读写挂载，否则容器内 git 无法解析 `.git` 指针（worktree add 会写 worktrees/
    // <name> 与 refs，都在共享目录里）；与 issue 17 汇总的补挂是同一取舍
    const repoRootReal = fs.realpathSync(repoRoot);
    const extraGrants = worktreeExtraGrants(repoRootReal, commonGitDir, "父仓库本身是 worktree：创建副本需要共享 Git 目录读写（issue 17）");
    const result = await this.deps.createWorktreeInContainer({
      workspace: repoRootReal,
      copyDir: copyDirReal,
      branch,
      command,
      extraGrants,
    });
    if (result.isError) {
      const label = result.errorMessage ?? result.content;
      throw new SubAgentDelegationError(
        "worktree_failed",
        `副本创建失败（路径 ${copyDir}，分支 ${branch}）：${label}；宿主保留现场供核查，不自动重建`,
      );
    }
    const baseCommit = /[0-9a-f]{40}/.exec(result.content)?.[0];
    if (!baseCommit) {
      throw new SubAgentDelegationError(
        "worktree_failed",
        `副本创建失败（路径 ${copyDir}，分支 ${branch}）：无法从容器输出核实基线提交（${result.content.trim() || "(empty)"}）`,
      );
    }
    let copyStat: fs.Stats;
    try {
      copyStat = fs.statSync(copyDir);
    } catch {
      throw new SubAgentDelegationError("worktree_failed", `副本创建后目录不可达（路径 ${copyDir}，分支 ${branch}）：创建失败，现场保留供核查`);
    }
    return {
      kind: "worktree",
      repoRoot: fs.realpathSync(repoRoot),
      commonGitDir,
      gitdir: path.join(commonGitDir, "worktrees", workId),
      path: copyDirReal,
      dev: copyStat.dev,
      ino: copyStat.ino,
      branch,
      baseCommit,
    };
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
    return { work, agent, task, created: false, newWork: false };
  }

  /**
   * 执行身份能读目标（posix 权限位逐级匹配）：容器后端按 uid/gid 匹配
   * owner/group/other；local 后端即后台账户，用 accessSync 核实。
   * ponytail: 只查目标本身的权限位；目录祖先的遍历位由 worker 调用时如实失败。
   */
  private executionCanRead(real: string, stat: fs.Stats): boolean {
    const id = this.deps.executionReaderIdentity?.() ?? null;
    // macOS Docker Desktop 的 VM 把容器内文件访问映射为宿主账户执行，POSIX 位按
    // 容器 uid 核恒假；按后台账户核实才是真实可达到的访问（容器边界仍硬性约束越界）
    if (!id || process.platform === "darwin") {
      try {
        fs.accessSync(real, fs.constants.R_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
        return true;
      } catch {
        return false;
      }
    }
    const need = stat.isDirectory() ? 0o5 : 0o4;
    const mode = stat.mode;
    const bits = stat.uid === id.uid ? (mode >> 6) & 0o7 : stat.gid === id.gid ? (mode >> 3) & 0o7 : mode & 0o7;
    return (bits & need) === need;
  }

  /**
   * 执行身份能写目标（issue 16，权限位思路镜像 executionCanRead）：容器后端
   * 按 uid/gid 匹配 owner/group/other；local 后端即后台账户用 accessSync 核实。
   * 工作区写位变更是宿主经容器边界的唯一硬约束；hooks/config 由宿主守护
   * （db.ts 的 protectedRoots 与 runtime 的 mounted.container.env.extras 不触及）。
   */
  private executionCanWrite(real: string, stat: fs.Stats): boolean {
    const id = this.deps.executionReaderIdentity?.() ?? null;
    // macOS Docker Desktop 的 VM 把容器内写操作映射为宿主账户身份执行（见 executionCanRead），
    // 按容器 uid 核 POSIX 位恒假；按后台账户核实
    if (!id || process.platform === "darwin") {
      try {
        fs.accessSync(real, fs.constants.W_OK | (stat.isDirectory() ? fs.constants.X_OK : 0));
        return true;
      } catch {
        return false;
      }
    }
    const need = stat.isDirectory() ? 0o3 : 0o2;
    const mode = stat.mode;
    const bits = stat.uid === id.uid ? (mode >> 6) & 0o7 : stat.gid === id.gid ? (mode >> 3) & 0o7 : mode & 0o7;
    return (bits & need) === need;
  }

  /** dev 待读路径：与父工作区及父任务已授予范围取交集，只读、拒绝保护根。 */
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
      // 交集：父工作区内，或父任务 grantedPaths 明确授予（read 或 read_write）。
      const inWorkspace = grantCoversPath(parentSession.cwdReal, real);
      const granted = parent.grantedPaths.some((g) => {
        if (g.access !== "read" && g.access !== "read_write") return false;
        try {
          return grantCoversPath(fs.realpathSync(g.path), real);
        } catch {
          return false;
        }
      });
      if (!inWorkspace && !granted) {
        throw new SubAgentDelegationError(
          "forbidden",
          `待读路径超出父工作区与已授予范围：${raw}（只允许父工作区内或父任务授予的只读路径）`,
        );
      }
      try {
        assertGrantNotProtected(real, this.deps.protectedRoots());
      } catch (err) {
        throw new SubAgentDelegationError("forbidden", (err as Error).message);
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const stat = fs.statSync(real);
      if (!this.executionCanRead(real, stat)) {
        throw new SubAgentDelegationError("forbidden", `实际执行身份不可读：${raw}（权限位不满足容器/执行账户身份）`);
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
    const modify = (input.mode ?? "analyze") === "modify" && writeTarget;
    const lines: string[] = [
      modify ? "[SubAgent 委派 · 工作区修改]" : "[SubAgent 委派 · 只读分析]",
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
          `模式：修改（worktree 隔离）。独立副本工作目录 ${writeTarget.path}，` +
            `基线 ${writeTarget.baseCommit.slice(0, 12)}（父工作区字节不变、副本脱离主会话共享锁）；` +
            `分支 ${writeTarget.branch}（宿主后台生成的本地 worktree，不提交、不推送）。`,
          "不要 git add/commit：改动留在工作树，由主 Agent 汇总。",
          "共享 Git 目录只读，仓库 hooks/config 不可达；写入范围由容器边界约束，跨目录写由父会话目录占用串行。",
        );
      } else {
        lines.push(
          `模式：修改（直接写入，与主会话按目录占用串行）。写入根 ${writeTarget.path}；` +
            `后续任务在同一写入根上由占用串行，不会与父会话的当前执行互相覆盖。`,
        );
      }
    }
    lines.push(
      hasMaterials ? `资料：本目录 ${materialsFileFor(workId, input.key)} 是宿主选定的资料快照（快照正文不重新解析）。` : "资料：没有附带资料快照。",
      paths.length > 0 ? `只读路径（宿主钉定）：${paths.map((p) => p.path).join("、")}` : "只读路径：无。",
      modify
        ? "你的工具只有 read / edit / write / bash / read_artifact / subagent_message（在本会话工作区边界内运行）；" +
          "bash 与本目录的读写均以本副本为界，不能修改其他目录或委派下级。"
        : "你的工具只有 read / read_artifact / subagent_message：可以读取上述范围与本目录；不能修改文件、执行命令、访问网络或委派下级。",
      "同项工作的协作：用 subagent_message 向主 Agent 或当前承接本工作的其他 SubAgent 发送有来源的消息（彼此上下文不自动共享）；" +
        "协作消息会作为本工作的新任务送达你。消息不扩大任何一方的工具与资料范围。",
      ...(modify
        ? [
            "结束修改前在副本内完成与该改动相关的检查（类型、测试、构建等可见命令），并在结论里如实报告" +
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

/** 工具操作账本族核实：委派按工作/Agent/会话/任务关联核实；关闭按 closed_at 核实；取消按 canceled_at 核实；汇总按 work_delegation.integrated 事件核实。 */
export function subagentOpCheck(coreStore: Store): {
  verify(op: { taskId: string; toolName?: string; params: Record<string, unknown> }): "committed" | "not_committed" | "unverifiable";
  committed(when: string): string;
  notCommitted(when: string): string;
} {
  return {
    verify: (op) => {
      if (op.toolName === "subagent_close") {
        const agent = typeof op.params.sub_agent_id === "string" ? coreStore.getSubAgent(op.params.sub_agent_id) : null;
        if (!agent) return "not_committed";
        return agent.closedAt !== null ? "committed" : "not_committed";
      }
      if (op.toolName === "subagent_cancel") {
        const work = typeof op.params.work_id === "string" ? coreStore.getWorkDelegation(op.params.work_id) : null;
        if (!work) return "not_committed";
        return work.canceledAt !== null ? "committed" : "not_committed";
      }
      // 工作内消息（issue 13）：按（工作, 发送方, 键）的消息行核实；
      // 发送方由发起任务的 SubAgent 关联推出（null = 主 Agent），与登记口径一致
      if (op.toolName === "subagent_message") {
        const task = coreStore.getTask(op.taskId);
        const workId = typeof op.params.work_id === "string" ? op.params.work_id : null;
        if (!task || !workId) return "not_committed";
        const msg = coreStore.findSubAgentMessage(workId, task.subAgentId ?? null, String(op.params.key ?? ""));
        return msg !== null ? "committed" : "not_committed";
      }
      if (op.toolName === "subagent_integrate") {
        // 改动汇总（issue 17）：套用与事件登记分两步，缺事件时不能说「未生效」
        // （可能 apply 已落字节、登记前崩溃）——如实报无法核实
        const work = typeof op.params.work_id === "string" ? coreStore.getWorkDelegation(op.params.work_id) : null;
        if (!work) return "unverifiable";
        return coreStore.hasIntegratedEvent(work.id) ? "committed" : "unverifiable";
      }
      const task = coreStore.getTask(op.taskId);
      if (!task) return "not_committed";
      const work = typeof op.params.work_id === "string" && op.params.work_id
        ? coreStore.getWorkDelegation(op.params.work_id)
        : coreStore.findWorkDelegation(task.sessionId, String(op.params.key ?? ""));
      if (!work) return "not_committed";
      const agent = coreStore.getSubAgent(work.subAgentId);
      if (!agent || coreStore.getSession(agent.sessionId) === null) return "not_committed";
      const child = coreStore.findTaskByRequest(agent.sessionId, subAgentTaskRequestId(work.id, String(op.params.key ?? work.requestKey)));
      return child !== null ? "committed" : "not_committed";
    },
    committed: (when) => `已提交：SubAgent 操作已登记（${when}已生效）`,
    notCommitted: (when) => `已知未提交：不存在对应的 SubAgent 记录（${when}未生效）`,
  };
}
