/**
 * 后台编排器（issue 01 日常助手）：逻辑角色 main/coding/chat 的引导、持久
 * 入站事件的登记与派发、父子任务结果回传与有界唤醒、子任务超时取消、
 * 重启恢复。
 *
 * 窄入口：只经 OrchestratorBridge 调用 Runtime 的少量方法；不持有拥有者
 * token，不能审批、改权限、开完全访问或读取其他项目资料。main 的委派工具
 * 只经 delegateCoding 提交受限请求，控制面 ops 不接受编排字段，只有本组件
 * 能创建子任务。
 *
 * 角色配置（项目/会话/工作目录/模型/工具白名单）只由本组件在引导时写入
 * agent_roles 表；输入正文、项目指令与模型结果不能修改。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Store } from "../core/store.ts";
import type { HistoryEntryView } from "../core/history.ts";
import { QQ_GROUP_SOURCE, type QqStore } from "../qq/store.ts";
import {
  AGENT_ROLE_IDS,
  normalizeIsoInstant,
  isTerminalTaskStatus,
  type AccessMode,
  type AgentRole,
  type AgentRoleId,
  type InboundEvent,
  type ModelSelection,
  type NotifyTarget,
  type PersistentEvent,
  type Task,
} from "../core/types.ts";
import { sessionToolCategories } from "../agent/tool-availability.ts";

/** 编排器需要的 Runtime 窄接口（宿主注入；除此之外的能力编排器不可见）。 */
export interface OrchestratorBridge {
  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    modelSelection: ModelSelection;
    agentId?: AgentRoleId | null;
    parentTaskId?: string | null;
    sourceEventId?: string | null;
    deadline?: string | null;
  }): Promise<Task>;
  cancelTask(taskId: string, reason?: string): Promise<Task>;
  findProjectByName(name: string): { id: string } | null;
  createProject(name: string): { id: string };
  createSession(input: { projectId: string; cwd: string }): Promise<{ id: string }>;
  /** 指定任务的最终 assistant 文本（按任务关联的历史条目，不取会话最新一条）。 */
  readTaskReply(taskId: string, offset: number, length: number): HistoryEntryView | null;
  resumeQueue(sessionId: string): Promise<unknown>;
  kickSession(sessionId: string): void;
  defaultModelSelection(): ModelSelection;
}

export interface OrchestratorDeps {
  store: Store;
  qqStore: QqStore;
  /** 后台数据目录（角色工作目录在其兄弟目录 agent-work/ 下，避开保护根）。 */
  dataDir: string;
  bridge: OrchestratorBridge;
  /** 超时巡检间隔（默认 1s；测试可压短）。 */
  deadlineCheckMs?: number;
  /**
   * 入站事件关联任务的结果事务内回调（issue 04 owner 回复）：与结果/事件终态
   * 同事务提交，重启巡检补记结果时一并补登，不会重复。
   */
  onInboundTerminal?(event: InboundEvent, task: Task, outcome: ChildOutcome): void;
  /** 入站派发前复核宿主配置与在线状态；等待保留原事件，失效则作废。 */
  inboundGate?(event: InboundEvent): "run" | "wait" | { drop: string };
  /** 宿主为已验证的入站事件安排固定 main 父任务与 coding review；模型不参与派发。 */
  reviewRequest?(event: InboundEvent): string | null;
  /** 结果落库前保存交付产物与来源元数据；重启补记走同一路径。 */
  resultData?(task: Task, outcome: ChildOutcome): Record<string, unknown>;
  resultNotice?(task: Task): string | null;
}

/** 角色静态定义（各角色的工具类别见 tool-availability 的会话类别清单）。 */
const ROLE_DEFINITIONS: Array<{ id: AgentRoleId; projectName: string }> = [
  { id: "main", projectName: "agent-main" },
  { id: "coding", projectName: "agent-coding" },
  { id: "chat", projectName: "agent-chat" },
];

/** 委派/事件输入正文上限（登记时截断，超出部分不入库）。 */
const INPUT_TEXT_CAP = 8192;
/** 子任务结果摘要上限（写入任务记录与唤醒输入）。 */
const RESULT_SUMMARY_CAP = 1000;
/** 超时取消的持久化原因（canceled 事件与启动巡检据此判定 timeout，重启后不丢）。 */
const DEADLINE_REASON = "deadline_exceeded";

/** coding 委派意图（非只读沙箱）：analyze 读取分析，draft 在工作目录生成修改草稿。 */
export type DelegationMode = "analyze" | "draft";
/** 委派 coding 的宿主固定参数：每个父任务的委派上限与子任务时限。 */
export const DELEGATION_LIMITS = { perParent: 3, deadlineMs: 60 * 60_000 };
/** 委派正文首行由宿主写入（模式的持久记录；模型正文在其后，不能伪造首行）。 */
const DELEGATION_HEADER = /^\[委派 coding · (analyze|draft)\]\n/;
// 仅重试可证明只读或无副作用的操作（todo_write 只替换会话内清单）；bash、MCP、记忆写入及未知工具一律不猜测副作用。
const RETRY_SAFE_TOOLS = new Set(["read", "read_artifact", "history_search", "history_read", "memory_list", "memory_read", "web_search", "skill", "todo_write"]);

/** 委派 coding 的子任务模式（非委派任务为 null）。 */
export function delegationMode(task: Task): DelegationMode | null {
  return task.agentId === "coding" ? ((DELEGATION_HEADER.exec(task.input)?.[1] as DelegationMode | undefined) ?? null) : null;
}

/** 原始委派参数的宿主摘要；正文快照变化不改变同参委派的身份。 */
export function delegationRequestDigest(task: Task): string | null {
  if (task.agentId !== "coding") return null;
  return /^\[委派 coding · (?:analyze|draft)\]\n\[委派参数 SHA-256：([a-f0-9]{64})\]\n/.exec(task.input)?.[1] ?? null;
}

/** 子任务终态口径（completed/failed/timeout/unknown），事件、摘要与唤醒共用。 */
export type ChildOutcome = "completed" | "failed" | "timeout" | "unknown";

/**
 * 委派 coding 的结构化结果（issue 05，写入 result_ref JSON；保留 sessionId/taskId）。
 * tests 与自报的需要拥有者来自 coding 最终回答末尾的固定格式；其余由宿主按任务事实判定。
 */
export interface DelegationResult {
  sessionId: string;
  taskId: string;
  mode: DelegationMode;
  outcome: ChildOutcome;
  tests: "passed" | "failed" | "not_run" | "unreported";
  needsOwner: boolean;
  needsOwnerReason: string | null;
  effect: "unknown" | "none_unknown";
  failure: string | null;
  artifactIds: string[];
  /** 已自动重试时指向重试子任务（本次结果不再唤醒 main）。 */
  retriedBy?: string;
}

const TESTS_TEXT: Record<DelegationResult["tests"], string> = { passed: "通过", failed: "失败", not_run: "未运行", unreported: "未报告" };

const OUTCOME_TEXT: Record<ChildOutcome, string> = {
  completed: "已完成",
  failed: "失败",
  timeout: "超时",
  unknown: "结果未知",
};

function capInput(text: string): string {
  return text.length > INPUT_TEXT_CAP
    ? `${text.slice(0, INPUT_TEXT_CAP)}…（截断，原 ${text.length} 字符）`
    : text;
}

function codingInput(parentId: string, mode: DelegationMode, request: string, digest?: string): string {
  const body = `[委派 coding · ${mode}]\n` +
    (digest ? `[委派参数 SHA-256：${digest}]\n` : "") +
    `来自 main 的委派（父任务 ${parentId}）。工作目录由宿主固定为当前会话目录；需要仓库时在此目录内 git clone。\n` +
    (mode === "analyze" ? "模式 analyze：只做读取、运行与分析，不修改文件。\n" : "模式 draft：可在工作目录内生成修改草稿（不提交、不推送）。\n") +
    "不得发布到 GitHub 或其他外部服务（评论、PR、推送须拥有者在可信入口确认）。\n" +
    "结束时最后两行按格式报告：\n测试：通过|失败|未运行\n需要拥有者：是（原因）|否\n" +
    `---\n${request}`;
  if (body.length > INPUT_TEXT_CAP) throw new Error(`委派正文（含资料）超过 ${INPUT_TEXT_CAP} 字符，请精简或改用引用`);
  return body;
}

/** 一次委派的已核实参数（delegate 校验后经串行链交给 delegateChecked）。 */
interface DelegateArgs {
  parentTaskId: string;
  requestId: string;
  roleId: AgentRoleId;
  sessionId: string;
  modelSelection: ModelSelection;
  body: string;
  deadline: string | null;
  sourceEventId: string | null;
  requestDigest?: string;
  /** 父任务内的委派上限（仅 delegateCoding 设置；重复委派同键不计入）。 */
  maxChildren?: number;
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private started = false;
  private stopping = false;
  private deadlineTimer: NodeJS.Timeout | null = null;
  /** 事件派发串行化（注册与恢复共用同一入口，避免并发重提）。 */
  private dispatchChain: Promise<void> = Promise.resolve();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
  }

  private log(message: string): void {
    // 后台诊断输出（不含消息正文与秘密）
    process.stderr.write(`[ruukoto:orchestrator] ${message}\n`);
  }

  async start(): Promise<void> {
    this.started = true;
    await this.ensureRoles();
    // 崩溃窗口恢复①：已登记未建任务的事件按原请求键核实重提（幂等，不换新键）
    await this.recoverInbound();
    // 崩溃窗口恢复②：重启期间到达终态的角色任务补记结果与事件、补唤醒；
    // interrupted 一律按结果未知处理，不自动重放任何外部副作用
    await this.sweepPendingResults();
    // 角色会话的队列暂停由编排器自动恢复，但仅限 backend_restart（排队任务
    // 在重启后继续）；occupancy_unverified 等涉及未核实旧执行的暂停必须保留
    // 给拥有者核实（docs/runtime.md 恢复约定——角色任务有工具执行，不同于
    // 无工具的 QQ 会话，不能沿用其无条件恢复前提）
    for (const role of this.store.listAgentRoles()) {
      const session = this.store.getSession(role.sessionId);
      if (session && session.queueState === "paused" && session.queuePauseReason === "backend_restart") {
        await this.deps.bridge
          .resumeQueue(session.id)
          .catch((err) => this.log(`恢复角色 ${role.id} 队列失败：${(err as Error).message}`));
      }
    }
    const ms = this.deps.deadlineCheckMs ?? 1_000;
    this.deadlineTimer = setInterval(() => void this.checkDeadlines(), ms);
    this.deadlineTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.stopping = true;
    if (this.deadlineTimer) {
      clearInterval(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    // 等待已有派发链收尾；关闭期间新增派发被拒绝（dispatchRegistered 检查 stopping）
    await this.dispatchChain;
  }

  /**
   * 宿主专用的有界派发入口（issue 03 调度器）：派发已持久化的 registered 事件。
   * 与登记/恢复共用串行链与原请求键，重复调用不重复建任务；提交失败的事件
   * 保持 registered，由调用方按间隔再次调用补派，不依赖重启。
   */
  dispatchRegisteredEvents(): Promise<void> {
    return this.serial(() => this.dispatchRegistered());
  }

  /** 在派发串行链上执行（取消计划与派发在同一边界核对，覆盖提交任务与回填事件之间的竞争）。 */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.dispatchChain.then(fn);
    this.dispatchChain = run.then(() => {}, () => {});
    return run;
  }

  // ---------- 角色引导 ----------

  /** 幂等：已有角色行跳过（工具类别以 tool-availability 的清单为准，不读角色记录里的副本）。 */
  private async ensureRoles(): Promise<void> {
    for (const def of ROLE_DEFINITIONS) {
      if (this.store.getAgentRole(def.id)) continue;
      const project = this.deps.bridge.findProjectByName(def.projectName) ?? this.deps.bridge.createProject(def.projectName);
      const workDir = path.join(path.dirname(path.resolve(this.deps.dataDir)), "agent-work", def.id);
      fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
      // 角色会话的创建只能经此引导路径；控制面 create_session 不携带角色身份
      const session = await this.deps.bridge.createSession({ projectId: project.id, cwd: workDir });
      this.store.insertAgentRole({
        id: def.id,
        projectId: project.id,
        sessionId: session.id,
        workDir,
        modelSelection: null,
        tools: sessionToolCategories(def.id),
        createdAt: new Date().toISOString(),
      });
    }
  }

  // ---------- 入站事件 ----------

  /** 群入口只给收件键：会话、正文、触发者与目标全部从宿主收件记录取得。 */
  async registerQqGroup(dedupKey: string): Promise<void> {
    const row = this.deps.qqStore.getInbox(dedupKey);
    const config = this.deps.qqStore.getConfig();
    if (!row || !config || !row.sessionId) throw new Error("群收件或宿主会话绑定缺失");
    this.store.withTx(() => this.store.registerInboundEvent({
      source: QQ_GROUP_SOURCE, externalId: row.dedupKey, actor: row.userId, targetRole: "chat",
      // 原文首部的 qq 标签供撤回过滤使用；升级恢复也不得改写原请求参数。
      body: row.input, receivedAt: row.createdAt,
      replyTarget: { channel: QQ_GROUP_SOURCE, account: row.account, chatId: row.groupId, configVersion: row.configVersion ?? config.configVersion },
    }));
    this.enqueueDispatch();
  }

  /**
   * 登记入站事件（幂等）：重复 (source, externalId) 返回已存在事件且不重复
   * 建任务。登记与派发分离：先持久化，再在串行链上建任务；崩溃窗口由
   * 启动恢复按原请求键重提。
   */
  async registerInboundEvent(input: {
    source: string;
    externalId: string;
    actor?: string | null;
    targetRole: AgentRoleId;
    body: string;
    artifactRefs?: string[];
    replyTarget?: NotifyTarget | null;
  }): Promise<{ event: InboundEvent; created: boolean }> {
    if (!AGENT_ROLE_IDS.includes(input.targetRole)) throw new Error(`目标角色无效：${input.targetRole}`);
    if (!input.source.trim() || !input.externalId.trim()) throw new Error("入站事件的 source 与 external_id 不能为空");
    const { event, created } = this.store.withTx(() =>
      this.store.registerInboundEvent({
        source: input.source,
        externalId: input.externalId,
        actor: input.actor ?? null,
        targetRole: input.targetRole,
        body: capInput(input.body),
        artifactRefs: input.artifactRefs,
        replyTarget: input.replyTarget,
      }),
    );
    if (created) this.enqueueDispatch();
    return { event, created };
  }

  /**
   * 内部委派（issue 01）：只有编排器能创建子任务。幂等键在父任务范围内唯一
   * （请求键 deleg:<parentTaskId>:<key>）：同一父任务重复委派同参返回同一
   * 子任务；同键换参数（如更换目标角色，会落到另一角色会话）明确冲突，不
   * 产生第二个子任务。查重与提交串行执行（跨会话的唯一约束覆盖不到同键）。
   */
  async delegate(input: {
    parentTaskId: string;
    targetRole: AgentRoleId;
    input: string;
    deadline?: string | null;
    idempotencyKey: string;
    sourceEventId?: string | null;
    requestDigest?: string;
    maxChildren?: number;
  }): Promise<Task> {
    const parent = this.store.getTask(input.parentTaskId);
    if (!parent) throw new Error(`父任务不存在：${input.parentTaskId}`);
    const role = this.store.getAgentRole(input.targetRole);
    if (!role) throw new Error(`角色未引导：${input.targetRole}`);
    if (!input.idempotencyKey.trim()) throw new Error("委派幂等键不能为空");
    let deadline: string | null = null;
    if (input.deadline != null) {
      deadline = normalizeIsoInstant(input.deadline);
      if (deadline === null) throw new Error(`截止时间无效：${input.deadline}`);
    }
    const args: DelegateArgs = {
      parentTaskId: parent.id,
      requestId: `deleg:${parent.id}:${input.idempotencyKey}`,
      roleId: role.id,
      sessionId: role.sessionId,
      modelSelection: role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
      // 跨角色传递只带固定字段：委派正文 + 截止；不复制父任务的会话历史
      body: capInput(input.input),
      deadline,
      sourceEventId: input.sourceEventId ?? null,
      requestDigest: input.requestDigest,
      maxChildren: input.maxChildren,
    };
    const run = this.dispatchChain.then(() => this.delegateChecked(args));
    this.dispatchChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * main 委派 coding（issue 05，coding_delegate 工具的宿主入口）：目标角色、
   * 工作目录（角色会话）、confirm 模式与截止时间由宿主固定，模型只给正文、
   * 模式与幂等键。截止时间取父任务开始时刻 + 时限（确定值：同键重试不因
   * 时间变化而冲突）。
   */
  delegateCoding(input: { parentTaskId: string; mode: DelegationMode; request: string; idempotencyKey: string; requestDigest?: string }): Promise<Task> {
    const parent = this.store.getTask(input.parentTaskId);
    if (!parent) throw new Error(`父任务不存在：${input.parentTaskId}`);
    const body = codingInput(parent.id, input.mode, input.request, input.requestDigest);
    return this.delegate({
      parentTaskId: parent.id,
      targetRole: "coding",
      input: body,
      deadline: new Date(Date.parse(parent.startedAt ?? parent.createdAt) + DELEGATION_LIMITS.deadlineMs).toISOString(),
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      // 不传父任务的来源事件：子任务终态会回写来源事件并触发 owner 回复
      // （ADR 0011：子任务结果不自动外发）；来源经 parentTaskId 可追溯
      maxChildren: DELEGATION_LIMITS.perParent,
    });
  }

  private async delegateChecked(args: DelegateArgs): Promise<Task> {
    const existing = this.store.findChildTask(args.parentTaskId, args.requestId);
    if (existing) {
      const same =
        existing.agentId === args.roleId &&
        (existing.input === args.body || (args.requestDigest !== undefined && delegationRequestDigest(existing) === args.requestDigest)) &&
        (existing.deadline ?? null) === args.deadline &&
        (existing.sourceEventId ?? null) === args.sourceEventId;
      if (!same) {
        throw new Error(`委派幂等键冲突：${args.requestId} 已绑定参数不同的子任务 ${existing.id}`);
      }
      return existing;
    }
    if (args.maxChildren !== undefined && this.store.countDelegations(args.parentTaskId) >= args.maxChildren) {
      throw new Error(`父任务 ${args.parentTaskId} 的委派已达上限 ${args.maxChildren}`);
    }
    return this.deps.bridge.submit({
      sessionId: args.sessionId,
      requestId: args.requestId,
      input: args.body,
      modelSelection: args.modelSelection,
      agentId: args.roleId,
      parentTaskId: args.parentTaskId,
      sourceEventId: args.sourceEventId,
      deadline: args.deadline,
      // 子任务一律采用宿主固定的 confirm 模式：不继承目标角色会话的默认模式
      accessMode: "confirm",
    });
  }

  /** 已登记未建任务的事件串行重提（启动恢复）。 */
  private async recoverInbound(): Promise<void> {
    const pending = this.store.listInboundByStatus(["registered"]);
    if (pending.length > 0) this.log(`恢复 ${pending.length} 条已登记未建任务的入站事件`);
    for (const event of pending) await this.dispatchEvent(event);
  }

  private enqueueDispatch(): void {
    void this.serial(() => this.dispatchRegistered()).catch(() => {});
  }

  private async dispatchRegistered(): Promise<void> {
    for (const event of this.store.listInboundByStatus(["registered"])) {
      if (this.stopping) return;
      await this.dispatchEvent(event);
    }
  }

  /**
   * 为事件建任务并入队。请求键 evt:<eventId> 幂等：崩溃发生在建任务与
   * 标记之间时，重提命中同一请求键返回既有任务，不重复创建。
   */
  private async dispatchEvent(event: InboundEvent): Promise<void> {
    // 列表读取后可能已被作废（如调度计划取消）：只派发仍为 registered 的事件
    if (this.store.getInboundEvent(event.id)?.status !== "registered") return;
    const gate = this.deps.inboundGate?.(event) ?? "run";
    const group = event.source === QQ_GROUP_SOURCE ? this.deps.qqStore.getInbox(event.externalId) : null;
    if (gate === "wait") return;
    if (gate !== "run") {
      this.store.withTx(() => {
        this.store.failRegisteredInbound(event.id);
        this.store.appendEvent({ type: "inbound.skipped", eventId: event.id, source: event.source, reason: gate.drop });
        if (group) this.deps.qqStore.setInboxStatus(group.dedupKey, "skipped");
      });
      const previous = group?.sessionId ? this.store.findTaskByRequest(group.sessionId, group.requestId) : null;
      if (previous && !isTerminalTaskStatus(previous.status)) await this.deps.bridge.cancelTask(previous.id, gate.drop);
      return;
    }
    const role = this.store.getAgentRole(event.targetRole);
    if (!role) {
      this.log(`事件 ${event.id} 目标角色 ${event.targetRole} 未引导，跳过`);
      return;
    }
    const input =
      `[入站事件] 来源：${event.source} 外部 id：${event.externalId} actor：${event.actor ?? "未知"}\n` +
      event.body +
      (event.artifactRefs.length > 0 ? `\n产物引用：${JSON.stringify(event.artifactRefs)}` : "");
    let task: Task;
    try {
      const review = this.deps.reviewRequest?.(event);
      if (event.source === QQ_GROUP_SOURCE) {
        const mapping = group ? this.deps.qqStore.getGroupSession(group.account, group.groupId) : null;
        const session = mapping ? this.store.getSession(mapping.sessionId) : null;
        if (!group || !mapping || !session || session.kind !== "qq_group" || group.sessionId !== session.id ||
            session.projectId !== mapping.projectId || event.targetRole !== "chat" || event.actor !== group.userId || event.body !== group.input) {
          throw new Error("群入站与宿主会话绑定不匹配");
        }
        const existing = this.store.findTaskByRequest(session.id, group.requestId);
        if (existing && (existing.input !== group.input || existing.accessMode !== "confirm" || existing.parentTaskId ||
            (existing.agentId !== null && existing.agentId !== "chat") || (existing.sourceEventId !== null && existing.sourceEventId !== event.id))) {
          throw new Error("旧群请求的任务归属不匹配");
        }
        // 旧任务先核实原键和原文再接管，不能新增编排字段后重提而破坏旧摘要。
        task = existing ?? await this.deps.bridge.submit({
          sessionId: session.id, requestId: group.requestId, input: group.input,
          modelSelection: session.modelSelection ?? role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
          agentId: "chat", sourceEventId: event.id, accessMode: "confirm",
        });
      } else if (review !== undefined && review !== null) {
        const main = this.store.getAgentRole("main")!;
        const coding = this.store.getAgentRole("coding")!;
        const deadline = new Date(Date.parse(event.receivedAt) + DELEGATION_LIMITS.deadlineMs).toISOString();
        const parent = this.store.findTaskByRequest(main.sessionId, `evt:${event.id}:main`) ?? await this.deps.bridge.submit({
          sessionId: main.sessionId, requestId: `evt:${event.id}:main`,
          input: `[编排器] 已接纳 review 事件 ${event.id}。宿主负责创建 coding 子任务；本回合只确认接收，待结果唤醒后再摘要。`,
          modelSelection: main.modelSelection ?? this.deps.bridge.defaultModelSelection(),
          agentId: "main", sourceEventId: event.id, accessMode: "confirm", deadline,
        });
        // 已在派发串行链中，不能再次调用 delegate() 排到自己后面等待。
        task = await this.delegateChecked({
          parentTaskId: parent.id, requestId: `deleg:${parent.id}:review`, roleId: "coding", sessionId: coding.sessionId,
          modelSelection: coding.modelSelection ?? this.deps.bridge.defaultModelSelection(),
          body: codingInput(parent.id, "analyze", review), sourceEventId: event.id,
          deadline,
        });
      } else task = await this.deps.bridge.submit({
        sessionId: role.sessionId,
        requestId: `evt:${event.id}`,
        input,
        modelSelection: role.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: role.id,
        sourceEventId: event.id,
        // 入站事件（定时唤醒、Telegram 等）一律采用宿主固定的 confirm 模式：
        // 正文不能设置权限，也不继承会话默认的完全访问
        accessMode: "confirm",
      });
    } catch (err) {
      this.log(`事件 ${event.id} 建任务失败：${(err as Error).message}`);
      return; // 保持 registered，下次启动恢复重提
    }
    this.store.withTx(() => {
      if (group) {
        this.store.db.prepare("UPDATE tasks SET agent_id = 'chat', source_event_id = ? WHERE id = ?").run(event.id, task.id);
        this.deps.qqStore.linkInboxTask(group.dedupKey, task.sessionId, task.id);
      }
      this.store.markInboundQueued(event.id, task.id);
      // 任务已落库/已结束、事件回填前崩溃的窗口也沿用原任务。
      const recorded = this.store.getTask(task.id)!;
      if (recorded.resultSummary !== null) this.store.setInboundTerminal(event.id, recorded.status === "completed" ? "done" : "failed");
    });
    if (group) {
      const recorded = this.store.getTask(task.id)!;
      if (isTerminalTaskStatus(recorded.status)) await this.handleTerminal(recorded, this.outcomeFromStatus(recorded));
      else this.deps.bridge.kickSession(task.sessionId);
    }
  }

  // ---------- 结果回传与唤醒 ----------

  /** Runtime 事件监听：角色任务到达终态时记录结果、发子任务事件、唤醒父任务。 */
  onRuntimeEvents(events: PersistentEvent[]): void {
    if (!this.started) return;
    for (const event of events) {
      const body = event.body;
      if (
        body.type !== "task.completed" &&
        body.type !== "task.failed" &&
        body.type !== "task.canceled" &&
        body.type !== "task.interrupted"
      ) {
        continue;
      }
      const task = this.store.getTask(body.taskId);
      if (!task || !task.agentId) continue; // 只处理编排器创建的角色任务
      const outcome: ChildOutcome =
        body.type === "task.completed"
          ? "completed"
          : body.type === "task.interrupted"
            ? "unknown"
            : this.isDeadlineCancel(task)
              ? "timeout"
              : "failed";
      void this.handleTerminal(task, outcome).catch((err) => this.log(`结果回传失败：${(err as Error).message}`));
    }
  }

  /** 超时取消的判定：取消原因在取消时持久化（errorMessage/interruptReason），重启后仍可核对。 */
  private isDeadlineCancel(task: Task): boolean {
    return task.errorMessage === DEADLINE_REASON || task.interruptReason === DEADLINE_REASON;
  }

  /** 由任务持久状态推导终态口径（启动巡检与补发唤醒共用）。 */
  private outcomeFromStatus(task: Task): ChildOutcome {
    if (task.status === "completed") return "completed";
    if (task.status === "interrupted") return "unknown";
    if (task.status === "canceled" && this.isDeadlineCancel(task)) return "timeout";
    return "failed";
  }

  /**
   * 启动巡检：
   * ① 重启窗口内到达终态的角色任务补记结果与事件（handleTerminal 内含唤醒）；
   * ② 结果已落库但唤醒缺失（提交失败或①之前的崩溃窗口）的子任务，按原
   *   幂等键 wake:<childId> 补发——唤醒任务的存在即投递记录，重复恢复不重复
   *   投递。
   */
  private async sweepPendingResults(): Promise<void> {
    for (const task of this.store.listRoleTasksPendingResult()) {
      await this.handleTerminal(task, this.outcomeFromStatus(task));
    }
    for (const task of this.store.listRoleTasksPendingWake()) {
      const parent = this.store.getTask(task.parentTaskId!);
      if (!parent || !this.store.getAgentRoleBySession(parent.sessionId)) continue; // 与 wakeParent 同一口径
      await this.wakeParent(task, this.outcomeFromStatus(task), task.resultSummary!);
    }
  }

  private async handleTerminal(task: Task, outcome: ChildOutcome): Promise<void> {
    if (this.store.getTask(task.id)?.resultSummary != null) return;
    const agentId = task.agentId!;
    const replyPage = outcome === "completed" ? this.deps.bridge.readTaskReply(task.id, 0, 4096) : null;
    const reply = replyPage?.text.trim() || null;
    const summary = this.resultSummary(task, outcome, reply);
    const mode = delegationMode(task);
    const result = mode ? this.delegationResult(task, mode, outcome, replyPage) : null;
    if (
      mode === "analyze" && task.parentTaskId && !task.sourceEventId && task.status === "failed" &&
      !task.effectUnknown && !task.requestId.endsWith(":retry") &&
      !this.store.listConfirmationsByTask(task.id).some((c) => c.status === "approved" || c.consumedAt !== null) &&
      this.store.listToolOpsByTask(task.id).every((op) => RETRY_SAFE_TOOLS.has(op.toolName) && !op.effectUnknown && op.resultSummary !== null)
    ) {
      // 先以确定参数建重试，再记录首次结果；崩溃后同键重提只返回原重试。
      try {
        const retry = await this.delegate({
          parentTaskId: task.parentTaskId,
          targetRole: "coding",
          input: task.input,
          idempotencyKey: `${task.requestId.slice(`deleg:${task.parentTaskId}:`.length)}:retry`,
          deadline: new Date(Date.parse(task.endedAt!) + DELEGATION_LIMITS.deadlineMs).toISOString(),
        });
        result!.retriedBy = retry.id;
      } catch (err) {
        // 提交可能已落库但应答失败：先按固定键核实，不能另建或提前唤醒。
        const retry = this.store.findChildTask(task.parentTaskId, `${task.requestId}:retry`);
        if (retry) {
          result!.retriedBy = retry.id;
        } else {
          result!.needsOwner = true;
          result!.needsOwnerReason = [result!.needsOwnerReason, `自动重试创建失败：${(err as Error).message}`].filter(Boolean).join("；");
        }
      }
    }
    const resultData = this.deps.resultData?.(task, outcome) ?? {};
    if (result?.needsOwnerReason && typeof resultData.needsOwnerReason === "string") {
      resultData.needsOwnerReason = `${result.needsOwnerReason}；${resultData.needsOwnerReason}`;
    }
    // 宿主保存的交付产物也进入现有结果清单。
    if (result) result.artifactIds = this.store.listArtifactsByTask(task.id).filter((a) => !a.name.startsWith("prompt-snapshot:")).map((a) => a.id);
    const resultRef = JSON.stringify({ ...(result ?? { sessionId: task.sessionId, taskId: task.id }), ...resultData });
    // 结果一次写入：重复回传（监听与巡检竞争、重启后重扫）只有第一个生效
    const recorded = this.store.withTx(() => {
      if (!this.store.setTaskResult(task.id, summary, resultRef)) return false;
      if (task.sourceEventId) {
        const event = this.store.getInboundEvent(task.sourceEventId);
        if (event?.taskId === task.id) this.store.setInboundTerminal(event.id, outcome === "completed" ? "done" : "failed");
        if (event) this.deps.onInboundTerminal?.(event, task, outcome);
      }
      const refs = { taskId: task.id, sessionId: task.sessionId };
      switch (outcome) {
        case "completed":
          this.store.appendEvent(
            { type: "child_task.completed", taskId: task.id, parentTaskId: task.parentTaskId, agentId, summary, resultRef },
            refs,
          );
          break;
        case "failed":
          this.store.appendEvent(
            {
              type: "child_task.failed",
              taskId: task.id,
              parentTaskId: task.parentTaskId,
              agentId,
              errorMessage: task.errorMessage ?? "已取消或失败",
            },
            refs,
          );
          break;
        case "timeout":
          this.store.appendEvent(
            { type: "child_task.timeout", taskId: task.id, parentTaskId: task.parentTaskId, agentId, deadline: task.deadline ?? "" },
            refs,
          );
          break;
        case "unknown":
          this.store.appendEvent(
            {
              type: "child_task.result_unknown",
              taskId: task.id,
              parentTaskId: task.parentTaskId,
              agentId,
              reason: task.interruptReason ?? "interrupted",
            },
            refs,
          );
          break;
      }
      return true;
    });
    if (recorded && task.parentTaskId && !result?.retriedBy) {
      await this.wakeParent(task, outcome, summary);
    }
  }

  private resultSummary(task: Task, outcome: ChildOutcome, reply: string | null): string {
    const cap = (s: string) => {
      const chars = [...s], suffix = "…（截断）";
      return chars.length > RESULT_SUMMARY_CAP ? chars.slice(0, RESULT_SUMMARY_CAP - suffix.length).join("") + suffix : s;
    };
    switch (outcome) {
      case "completed":
        return cap(reply || "（无文本输出）");
      case "failed":
        return cap(`子任务失败：${task.errorMessage ?? "已取消"}`);
      case "timeout":
        return `子任务超过截止时间 ${task.deadline ?? "?"}，已取消`;
      case "unknown":
        return "子任务被后台重启/中断，结果未知（未自动重放任何外部副作用）";
    }
  }

  private delegationResult(task: Task, mode: DelegationMode, outcome: ChildOutcome, firstPage: HistoryEntryView | null): DelegationResult {
    let tests: string | undefined;
    let selfOwner: RegExpMatchArray | undefined;
    let pending = "";
    // 先拼齐跨页的行，再取最后一次自报；长原因不能把字段名挤出固定尾窗。
    for (let page = firstPage; page;) {
      const end = page.offset + Buffer.byteLength(page.text);
      pending += page.text;
      const boundary = end >= page.totalBytes ? pending.length : pending.lastIndexOf("\n") + 1;
      const complete = pending.slice(0, boundary);
      const lastMatch = (re: RegExp) => [...complete.matchAll(re)].at(-1);
      tests = lastMatch(/^测试：\s*(通过|失败|未运行)/gm)?.[1] ?? tests;
      selfOwner = lastMatch(/^需要拥有者：[ \t]*(是|否)[ \t]*(?:[（(]([^）)\n]*)[）)])?/gm) ?? selfOwner;
      pending = pending.slice(boundary);
      if (end >= page.totalBytes || !page.text) break;
      page = this.deps.bridge.readTaskReply(task.id, end, 64 * 1024);
    }
    const reasons = [
      outcome === "unknown" ? "后台中断，结果未知，需要核实" : null,
      task.effectUnknown ? "存在效果未知的操作" : null,
      // 未答复即失效的才算未处理；获批后复核或消费失败而失效的（有决定来源）不算
      this.store.listConfirmationsByTask(task.id).some((c) => c.status === "pending" || (c.status === "stale" && c.decisionSource === null)) ? "有未处理的审批请求" : null,
      selfOwner?.[1] === "是" ? `coding 自报：${selfOwner[2]?.trim().slice(0, RESULT_SUMMARY_CAP) || "需要拥有者"}` : null,
    ].filter((r): r is string => r !== null);
    return {
      sessionId: task.sessionId,
      taskId: task.id,
      mode,
      outcome,
      tests: tests === "通过" ? "passed" : tests === "失败" ? "failed" : tests === "未运行" ? "not_run" : "unreported",
      needsOwner: reasons.length > 0,
      needsOwnerReason: reasons.length > 0 ? reasons.join("；") : null,
      effect: task.effectUnknown ? "unknown" : "none_unknown",
      failure: outcome === "completed" ? null : (task.errorMessage ?? task.interruptReason ?? OUTCOME_TEXT[outcome]),
      // 模型上下文快照（prompt-snapshot:*）是宿主诊断记录，不是 coding 的产物
      artifactIds: this.store.listArtifactsByTask(task.id).filter((a) => !a.name.startsWith("prompt-snapshot:")).map((a) => a.id),
    };
  }

  /**
   * main 的有界唤醒输入：固定模板 + 截断摘要（上限 RESULT_SUMMARY_CAP），
   * 只带固定字段与结果引用，不复制子任务完整历史；请求键 wake:<childId>
   * 幂等，重复结果回传只唤醒一次。唤醒只投向角色会话（main 等）——父任务
   * 在拥有者交互会话时结果经 get_task 查询，不向该会话注入输入。
   */
  private async wakeParent(child: Task, outcome: ChildOutcome, summary: string): Promise<void> {
    const parent = this.store.getTask(child.parentTaskId!);
    if (!parent) return;
    const parentRole = this.store.getAgentRoleBySession(parent.sessionId);
    if (!parentRole) return;
    const recorded = this.store.getTask(child.id) ?? child;
    const result = delegationMode(recorded) && recorded.resultRef ? (JSON.parse(recorded.resultRef) as DelegationResult) : null;
    const source = child.sourceEventId ? this.store.getInboundEvent(child.sourceEventId) : null;
    const reviewSource = source && this.deps.reviewRequest?.(source) ? source : null;
    const notice = this.deps.resultNotice?.(child);
    const input = result
      ? `[编排器] 子任务${OUTCOME_TEXT[outcome]}\n` +
        `子任务：${child.id}（角色 coding · 模式 ${result.mode}${child.requestId.endsWith(":retry") ? " · 自动重试后" : ""}）\n` +
        `摘要：${summary}\n` +
        `测试：${TESTS_TEXT[result.tests]}（coding 自报） · 需要拥有者：${result.needsOwner ? `是（${result.needsOwnerReason?.slice(0, 300)}）` : "否"} · ` +
        `效果未知：${result.effect === "unknown" ? "是" : "否"}${result.failure ? ` · 失败原因：${result.failure.slice(0, 300)}` : ""}\n` +
        `产物：${result.artifactIds.length > 0 ? result.artifactIds.slice(0, 20).join(", ") : "无"}\n` +
        `完整结果：用 coding_result 读取（task_id ${child.id}；part=reply 分页读最终回答，part=artifact 读产物）`
      : `[编排器] 子任务${OUTCOME_TEXT[outcome]}\n` +
        `子任务：${child.id}（角色 ${child.agentId}）\n` +
        `摘要：${summary}\n` +
        `完整结果：session ${child.sessionId} task ${child.id}（经 get_task / read_history 查询）`;
    try {
      await this.deps.bridge.submit({
        sessionId: parent.sessionId,
        requestId: `wake:${child.id}`,
        input: input + (notice ? `\n${notice}` : ""),
        modelSelection: parentRole.modelSelection ?? this.deps.bridge.defaultModelSelection(),
        agentId: parentRole.id,
        // 入站 review 的摘要保留宿主来源；普通 owner 委派仍无自动外发授权。
        sourceEventId: reviewSource?.id ?? null,
        deadline: reviewSource ? new Date(Date.parse(child.endedAt!) + DELEGATION_LIMITS.deadlineMs).toISOString() : null,
        // 子任务结果属于外部内容，不能继承 main 会话默认的完全访问。
        accessMode: "confirm",
      });
    } catch (err) {
      this.log(`唤醒父任务会话失败（child=${child.id}）：${(err as Error).message}`);
    }
  }

  // ---------- 超时巡检 ----------

  private async checkDeadlines(): Promise<void> {
    if (!this.started) return;
    const now = new Date().toISOString();
    for (const task of this.store.listOverdueTasks(now)) {
      try {
        // 取消原因持久化（deadline_exceeded）：canceled 事件与启动巡检据此判定 timeout
        await this.deps.bridge.cancelTask(task.id, DEADLINE_REASON);
      } catch {
        // 已到终态等竞争路径，交还给事件/巡检
      }
    }
  }
}
