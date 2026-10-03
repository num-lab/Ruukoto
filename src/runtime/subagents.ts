/**
 * 通用 SubAgent 委派（agent-direction issue 11，ADR 0020；issue 12 继续/复用/关闭）：
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
 * - 资料与路径：main 的资料在委派时经 SourceResolver 解析为文本快照写入子工作
 *   目录（来源引用保存在任务 read_scope，启动与每次发送上下文前按该 Agent 全部
 *   历史任务的并集重新 verify）；dev 的待读路径限于父工作区及父任务已授予范围
 *   （取交集只读），保存 realpath 与目录身份，路径经宿主钉定传入 worker。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "../core/store.ts";
import type {
  AccessMode,
  ModelSelection,
  Session,
  SubAgent,
  SubAgentClosedBy,
  SubAgentReadScope,
  Task,
  WorkDelegation,
} from "../core/types.ts";
import { randomId } from "../core/types.ts";
import type { SourceResolver } from "../agent/scheduler-tools.ts";
import type { SourceRef } from "../scheduler/store.ts";
import type { WorkerLauncher } from "../agent/execution/launchers.ts";
import { assertGrantNotProtected } from "../agent/execution/approved-ops.ts";
import { grantCoversPath } from "../core/worktree.ts";

/** 委派正文上限（登记时拒绝，超出不入库）。 */
const INPUT_TEXT_CAP = 8192;
/** 委派上限与任务时限：同一父用户会话的活动 SubAgent 执行任务数。 */
export const SUBAGENT_LIMITS = { perParentSession: 3, deadlineMs: 60 * 60_000 };
/**
 * 快照文件名（子工作目录内；按工作 + 执行键命名——复用同一 Agent 承接新工作
 * 时不覆写旧工作的快照；目录与文件名由宿主生成，key 字符集已经过 KEY_RE 校验）。
 */
function materialsFileFor(workId: string, key: string): string {
  return `materials-${workId}-${key}.txt`;
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
   * 复用既有空闲 SubAgent 承接新工作（issue 12；仅省略 workId 时使用，两者互斥）。
   * 复用保留该 Agent 的独立会话上下文；读范围与资料按本次任务重新钉定。
   */
  subAgentId?: string | null;
  /** main 选定资料（原样引用对象；重复委派不重新解析）。 */
  materials?: Record<string, unknown>[] | null;
  /** dev 待读取路径（宿主核实交集后钉定只读范围）。 */
  readPaths?: string[] | null;
  /** 工具计算的规范化参数摘要（覆盖 request/key/workId/subAgentId/materials/readPaths）。 */
  paramsDigest: string;
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

export interface SubAgentManagerDeps {
  store: Store;
  /** 子工作目录根（保护根之外，如 agent-work/sub-agents/）。 */
  workRoot: string;
  /** main 资料的解析与授权复核（重复委派不重新解析；verify 在发送前复核）。 */
  sources: SourceResolver;
  /** 模型配置门闩检查闭包（runOuter 预检、事务内重检）。 */
  resolveSelection(selection: ModelSelection): Promise<() => void>;
  launcherFor(mode: AccessMode): WorkerLauncher;
  defaultModelSelection(): ModelSelection;
  kickSession(sessionId: string): void;
  protectedRoots(): string[];
  /** 后台数据目录（拒绝把工作目录放进保护根）。 */
  dataDir: string;
  /**
   * 实际执行身份的 uid/gid（容器后端）；null = 以后台账户执行（权限位检查
   * 代替 identity 可达性核实）。用于准备时核实执行身份能读选定资料——不能用
   * 后台 UID 读通代替执行身份验证。
   */
  executionReaderIdentity?(): { uid: number; gid: number } | null;
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

  constructor(deps: SubAgentManagerDeps) {
    this.deps = deps;
  }

  private get store(): Store {
    return this.deps.store;
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
    if (parentSession.kind !== "dev") throw new SubAgentDelegationError("forbidden", "只有用户会话可以登记工作委托");
    if (!input.request.trim()) throw new SubAgentDelegationError("invalid_params", "委派正文不能为空");
    if (input.workId && input.subAgentId) {
      throw new SubAgentDelegationError("invalid_params", "work_id 与 sub_agent_id 互斥：补充原工作用 work_id，承接新工作用 sub_agent_id");
    }

    // —— 查重先：重复委派不重新解析可能已变化的资料（同键同参的重放即使目标
    // Agent 已关闭或忙碌也返回原记录，不新建任务）——
    const hit = input.workId ? this.dedupExistingWork(input, parentSession) : this.dedupNewKey(input, parentSession);
    if (hit) return hit;

    // —— 目标 Agent：继续沿工作的 Agent；复用按 subAgentId；两者都省略即新建 ——
    const reusedWork = input.workId ? this.store.getWorkDelegation(input.workId) : null;
    if (input.workId && !reusedWork) {
      throw new SubAgentDelegationError("not_found", `工作委托不存在或不属于本会话：${input.workId}`);
    }
    if (reusedWork && reusedWork.parentSessionId !== parentSession.id) {
      throw new SubAgentDelegationError("forbidden", "该工作委托不属于本会话");
    }
    let target = reusedWork ? this.store.getSubAgent(reusedWork.subAgentId) : null;
    if (reusedWork && !target) throw new SubAgentDelegationError("not_found", `工作 ${reusedWork.id} 缺少 SubAgent 记录`);
    if (input.subAgentId) {
      target = this.store.getSubAgent(input.subAgentId);
      if (!target) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${input.subAgentId}`);
    }
    // 继续与复用都要求可用（准备前一次；登记事务内再核一次）
    if (target) this.assertAvailable(target, parentSession);
    // 限额（查重后）：同一会话的活动执行任务上限
    const active = this.store.countActiveSubAgentTasks(parentSession.id);
    if (active >= SUBAGENT_LIMITS.perParentSession) {
      throw new SubAgentDelegationError(
        "limit_exceeded",
        `本会话的活动 SubAgent 任务已达上限 ${SUBAGENT_LIMITS.perParentSession}，等现有任务结束后再委派`,
      );
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
      inputText = this.taskInput(workId, parent, input, (input.materials?.length ?? 0) > 0, scopePaths);
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
        // 竞争仲裁（继续原工作）：同键可能已在本调用准备期间提交
        const racedWork = this.store.getWorkDelegation(workId);
        const racedAgent = racedWork ? this.store.getSubAgent(racedWork.subAgentId) : null;
        const racedTask = racedAgent ? this.store.findTaskByRequest(racedAgent.sessionId, requestId) : null;
        if (racedWork && racedAgent && racedTask) {
          if (racedWork.parentSessionId !== parentSession.id || racedTask.submissionDigest !== submissionDigest) {
            throw new SubAgentDelegationError("request_conflict", `委派幂等键冲突：${input.key} 已绑定参数不同的记录`);
          }
          return { work: racedWork, agent: racedAgent, task: racedTask, created: false, newWork: false };
        }
        check(); // 模型门闩重检必须在登记事务内
        // 可用性事务内重核：关闭/忙碌与登记的竞争在这里定胜负（先关闭则报已
        // 关闭；先登记则关闭侧报有活动任务）
        const agentNow = target ? this.store.getSubAgent(target.id) : null;
        if (target && !agentNow) throw new SubAgentDelegationError("not_found", `SubAgent 不存在：${target.id}`);
        if (agentNow) this.assertAvailable(agentNow, parentSession);
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
        if (racedWork && racedAgent) {
          agent = racedAgent;
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
            createdAt: new Date().toISOString(),
          };
          this.store.insertWorkDelegation(work);
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
            createdAt: now,
          };
          this.store.insertWorkDelegation(work);
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
    return this.store.withTx(() => {
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
      return { agent: this.store.getSubAgent(agent.id)!, alreadyClosed: false };
    });
  }

  /**
   * 继续/复用的可用性（issue 12）：同一父会话、未关闭、空闲且无活动任务
   * （忙碌明确拒绝不排队——继续委派覆盖 current_task_id 会让在跑任务显示
   * 空闲）；工作目录的 realpath 与目录身份必须与子会话记录一致（核对实际
   * 文件状态，目录被替换/删除时报明确错误，提示新建）。
   */
  private assertAvailable(agent: SubAgent, parentSession: Session): void {
    if (agent.parentSessionId !== parentSession.id) {
      throw new SubAgentDelegationError("forbidden", "该 SubAgent 不属于本会话");
    }
    if (agent.closedAt) {
      throw new SubAgentDelegationError("closed", `SubAgent 已关闭（${agent.closedAt}）：请新建 SubAgent`);
    }
    const activeTask = this.store.findActiveSubAgentTask(agent.id);
    if (agent.state !== "idle" || activeTask) {
      throw new SubAgentDelegationError(
        "busy",
        `SubAgent 正忙或待核实（状态 ${agent.state}${activeTask ? `，活动任务 ${activeTask.id}` : ""}）：等当前任务结束后再委派`,
      );
    }
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
  }

  /** 既有工作的同键核实：命中返回原任务，任务缺失即数据不一致（不新建）。 */
  private dedupExistingWork(input: SubAgentDelegateInput, parentSession: Session): SubAgentDelegation | null {
    const work = this.store.getWorkDelegation(input.workId!);
    if (!work || work.parentSessionId !== parentSession.id) return null;
    const agent = this.store.getSubAgent(work.subAgentId);
    if (!agent) throw new SubAgentDelegationError("not_found", `工作 ${work.id} 缺少 SubAgent 记录`);
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
    if (!id) {
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
  private taskInput(workId: string, parent: Task, input: SubAgentDelegateInput, hasMaterials: boolean, paths: SubAgentReadScope["paths"]): string {
    const lines = [
      "[SubAgent 委派 · 只读分析]",
      `工作 ${workId}（直接父任务 ${parent.id}，原样记录不作身份依据）。`,
      // 复用承接新工作时向模型说明：保留的上下文是旧工作的，范围以本次为准
      ...(input.subAgentId ? ["本 SubAgent 此前承接过其他工作；只读路径与资料以本次为准，之前的范围不延续。"] : []),
      hasMaterials ? `资料：本目录 ${materialsFileFor(workId, input.key)} 是宿主选定的资料快照（快照正文不重新解析）。` : "资料：没有附带资料快照。",
      paths.length > 0
        ? `只读路径（宿主钉定）：${paths.map((p) => p.path).join("、")}`
        : "只读路径：无。",
      "你的工具只有 read / read_artifact：可以读取上述范围与本目录；不能修改文件、执行命令、访问网络或委派下级。",
      "读不到所需资料就明说能力范围并请主 Agent 补充，不要尝试其他手段。结束时直接给出分析结论，结论会回到主 Agent。",
      `---\n${input.request}`,
    ];
    const body = lines.join("\n");
    // 与旧委派同口径：宿主模板 + 请求合计超过 cap 即拒绝（不截断）
    if (body.length > INPUT_TEXT_CAP) {
      throw new SubAgentDelegationError("invalid_params", `委派正文（含边界说明）超过 ${INPUT_TEXT_CAP} 字符，请精简`);
    }
    return body;
  }
}

/** 工具操作账本族核实：委派按工作/Agent/会话/任务关联核实；关闭按 closed_at 核实。 */
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
