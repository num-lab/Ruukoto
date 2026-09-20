/**
 * 后台运行时：调度、任务生命周期、恢复与占用管理。
 *
 * - 每会话 FIFO：同一会话一次执行一个任务，新消息持久化后排队；
 * - 目录互斥：dev+ino 占用（覆盖符号链接与挂载别名），不同目录可并行；
 * - 恢复：running/awaiting_confirmation → interrupted（backend_restart），
 *   未执行 queued 保留顺序并暂停自动调度，等待拥有者 resume_queue；
 * - 停止：先拒新任务、暂停调度，中断活动任务、回收工具进程，落盘后关闭；
 *   进程信号与控制面 stop 走同一路径。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Db } from "../core/db.ts";
import { isToolOpExecutionUncertain, Store, StoreConflictError } from "../core/store.ts";
import {
  ACTIVE_TASK_STATUSES,
  isTerminalTaskStatus,
  type AccessMode,
  type Artifact,
  type ConfirmationRequest,
  type GrantedPath,
  type PersistentEvent,
  type Project,
  type Session,
  type Task,
  type ToolOp,
  randomId,
} from "../core/types.ts";
import { acquireInstanceLock, type AcquiredLock } from "../core/instance-lock.ts";
import { resolveDirIdentity, verifyDirIdentity, DirIdentityError } from "../core/dir-identity.ts";
import { Driver } from "../agent/driver.ts";
import { createMockTools } from "../agent/mock-tools.ts";
import { createCodingTools } from "../agent/tool-router.ts";
import { ArtifactStore } from "../agent/artifacts.ts";
import { CredentialStore } from "../agent/execution/credentials.ts";
import {
  createLauncherFor,
  ExecutionError,
  type ExecutionBackendConfig,
} from "../agent/execution/launchers.ts";
import { sessionsDirFor } from "../agent/session-factory.ts";
import { fileURLToPath } from "node:url";
import { assertGrantNotProtected } from "../agent/execution/approved-ops.ts";
import { grantCoversPath, resolveWorktreeCommonGitDir } from "../core/worktree.ts";

/** 服务代码根目录（本模块位于 <codeRoot>/src/runtime/）。 */
const CODE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface RuntimeConfig {
  dataDir: string;
  /** pi 凭据与模型配置目录（显式指定，不读 ~/.pi/agent）。 */
  agentDir: string;
  /** 控制面目录（socket 与拥有者令牌；默认数据目录的兄弟目录 control/）。 */
  controlDir?: string;
  socketPath?: string;
  thinkingLevel?: "off" | "minimal" | "medium" | "high" | "xhigh";
  /** 默认取 models.json 的第一个模型；可显式指定 provider/id。 */
  modelProvider?: string;
  modelId?: string;
  /**
   * 工具执行后端：local（开发/验证，无隔离，禁止用于声明请求确认模式的
   * 边界）| container（Linux 容器边界）| systemd（执行账户入口）。
   * 省略时取 local：只适用于开发与模拟验证，生产部署必须显式配置。
   */
  execution?: ExecutionBackendConfig;
  /** 默认注册真实编码工具（路由器 + 工具工作进程）；模拟测试可覆盖。 */
  toolFactory?: (ctx: { registry: import("../agent/managed-processes.ts").ManagedProcessRegistry; router: import("../agent/tool-router.ts").ToolRouter }) => ToolDefinition[];
}

export class RuntimeApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class DirOccupiedError extends Error {}
class TaskGoneError extends Error {}

/**
 * 解析默认模型：显式配置优先；否则取 models.json 第一个 provider 的第一个
 * 模型。不得使用 getModels()[0]——pi 内置 provider 注册表也出现在那里，
 * 会静默选中无关的云端模型。
 */
async function resolveConfiguredModel(runtime: Runtime, config: RuntimeConfig): Promise<any> {
  const modelRuntime = runtime.modelRuntime;
  if (config.modelProvider) {
    return modelRuntime.getModel(config.modelProvider, config.modelId ?? "");
  }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.agentDir, "models.json"), "utf8")) as {
      providers?: Record<string, { models?: Array<{ id: string }> }>;
    };
    const entry = Object.entries(raw.providers ?? {}).find(([, def]) => (def.models?.length ?? 0) > 0);
    if (!entry) return undefined;
    const [providerId, def] = entry as [string, { models: Array<{ id: string }> }];
    return modelRuntime.getModel(providerId, def.models[0]!.id);
  } catch {
    return undefined;
  }
}

export class Runtime {
  readonly config: RuntimeConfig;
  private readonly db: Db;
  readonly store: Store;
  readonly artifacts: ArtifactStore;
  readonly credentials: CredentialStore;
  private readonly lock: AcquiredLock;
  modelRuntime!: ModelRuntime;
  private model: any;
  private drivers = new Map<string, Driver>();
  private loopActive = new Set<string>();
  private loopPromises = new Map<string, Promise<void>>();
  private wakePending = new Set<string>();
  stopping = false;
  private stopPromise: Promise<void> | null = null;
  /** 控制面注入：事件广播与停止回调。 */
  onEventBroadcast: ((events: PersistentEvent[]) => void) | null = null;
  onCloseServer: (() => Promise<void>) | null = null;

  private constructor(config: RuntimeConfig, db: Db, store: Store, lock: AcquiredLock) {
    this.config = config;
    this.db = db;
    this.store = store;
    this.lock = lock;
    this.artifacts = new ArtifactStore(config.dataDir, store);
    this.credentials = new CredentialStore(config.agentDir);
    store.onCommitted = (events) => this.onEventBroadcast?.(events);
  }

  /** 控制面目录（socket 与拥有者令牌所在）。 */
  controlDir(): string {
    return this.config.controlDir ?? path.join(path.dirname(path.resolve(this.config.dataDir)), "control");
  }

  /** 始终排除的保护根目录：后台数据、服务凭据、控制面与服务代码（realpath 规范化）。 */
  protectedRoots(): string[] {
    const canonical = (p: string): string => {
      try {
        return fs.realpathSync(p);
      } catch {
        return path.resolve(p);
      }
    };
    return [
      canonical(this.config.dataDir),
      canonical(this.config.agentDir),
      canonical(this.controlDir()),
      canonical(CODE_ROOT),
    ];
  }

  launcherFor(mode: AccessMode) {
    return createLauncherFor(this.config.execution ?? { backend: "local" }, mode);
  }

  static async start(config: RuntimeConfig): Promise<Runtime> {
    const fullConfig: RuntimeConfig = { ...config, execution: config.execution ?? { backend: "local" } };
    fs.mkdirSync(fullConfig.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(fullConfig.agentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDirFor(fullConfig.dataDir), { recursive: true, mode: 0o700 });

    const lock = acquireInstanceLock(fullConfig.dataDir);
    let runtime: Runtime;
    try {
      const db = new Db(fullConfig.dataDir);
      const store = new Store(db);
      runtime = new Runtime(fullConfig, db, store, lock);
    } catch (err) {
      lock.release();
      throw err;
    }

    runtime.modelRuntime = await ModelRuntime.create({
      authPath: path.join(fullConfig.agentDir, "auth.json"),
      modelsPath: path.join(fullConfig.agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const model = await resolveConfiguredModel(runtime, fullConfig);
    if (!model) {
      lock.release();
      throw new RuntimeApiError(
        "no_model",
        "未找到可用模型：models.json 中没有 provider，或指定的 provider/model 不存在",
      );
    }
    runtime.model = model;

    runtime.recover();
    runtime.store.withTx(() => {
      runtime.store.appendEvent({ type: "backend.started", dataDir: fullConfig.dataDir, executionBackend: fullConfig.execution!.backend });
    });
    return runtime;
  }

  socketPath(): string {
    return this.config.socketPath ?? path.join(this.controlDir(), "control.sock");
  }

  // ---------- 恢复 ----------

  private recover(): void {
    // 恢复是一次逻辑事务：任务中断、确认失效、占用事实、队列暂停与恢复
    // 事件要么全部提交，要么整体回滚，不留半恢复状态
    this.store.withTx(() => {
      const store = this.store;
      const interruptedTaskIds: string[] = [];
      const pausedSessionIds: string[] = [];

      // 1. 未完成执行 → interrupted；结果缺失的工具操作区分两种事实：
      //    - 审批未消费（pending/stale/rejected，或 approved 但未消费）→
      //      已知未执行，记录明确结果，不算效果未知；
      //    - 批准已消费（执行已开始）或无审批的直接执行 → 结果缺失且可能
      //      已产生外部效果 → effect_unknown，不重放。
      for (const task of store.listTasksByStatus(["running", "awaiting_confirmation"])) {
        const unresolved = store.listUnresolvedToolOps(task.id);
        const confirmations = store.listConfirmationsByTask(task.id);
        let effectUnknownCount = 0;
        for (const op of unresolved) {
          if (!isToolOpExecutionUncertain(op, confirmations)) {
            store.recordToolResult(op.id, "已知未执行：审批未消费即发生后台重启（批准不跨重启执行）", true);
            store.appendEvent(
              { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary: "已知未执行：审批未消费即发生后台重启", isError: true, artifactIds: [] },
              { taskId: task.id },
            );
            continue;
          }
          effectUnknownCount++;
          store.markToolOpEffectUnknown(op.id);
          store.appendEvent(
            { type: "task.tool_effect_unknown", taskId: task.id, toolOpId: op.id, toolName: op.toolName },
            { taskId: task.id },
          );
        }
        const changed = store.transitionTask(task.id, ["running", "awaiting_confirmation"], "interrupted", {
          interruptReason: "backend_restart",
          endedAt: new Date().toISOString(),
        });
        if (changed) {
          if (effectUnknownCount > 0) store.setEffectUnknown(task.id);
          store.stalePendingConfirmations(task.id);
          store.appendEvent(
            {
              type: "task.interrupted",
              taskId: task.id,
              sessionId: task.sessionId,
              reason: "backend_restart",
              cancelRequested: task.cancelRequested,
              effectUnknown: effectUnknownCount > 0,
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
          interruptedTaskIds.push(task.id);
        }
      }

      // 2. 遗留占用：旧后台已死但其子进程状态无法确认 → 保留占用，暂停会话，
      //    由拥有者核实后 resume_queue 释放（systemd KillMode=control-group 下
      //    子进程随服务终止，正常部署不会出现）。
      for (const occ of store.listAllOccupancy()) {
        store.appendEvent(
          { type: "occupancy.stale", sessionId: occ.sessionId, taskId: occ.taskId, cwdReal: occ.cwdReal },
          { sessionId: occ.sessionId, taskId: occ.taskId },
        );
        const session = store.getSession(occ.sessionId);
        if (session && session.queueState === "active") {
          store.setSessionQueueState(occ.sessionId, "paused", "occupancy_unverified");
          store.appendEvent(
            { type: "session.queue_paused", sessionId: occ.sessionId, reason: "occupancy_unverified" },
            { sessionId: occ.sessionId },
          );
          pausedSessionIds.push(occ.sessionId);
        }
      }

      // 3. 有排队任务的会话暂停自动调度，等待拥有者显式恢复
      for (const session of store.listSessions()) {
        const queued = store.listQueuedTasksFifo(session.id);
        if (queued.length > 0 && session.queueState === "active") {
          store.setSessionQueueState(session.id, "paused", "backend_restart");
          store.appendEvent(
            { type: "session.queue_paused", sessionId: session.id, reason: "backend_restart" },
            { sessionId: session.id },
          );
          pausedSessionIds.push(session.id);
        }
      }

      // 4. 修复会话与 JSONL 的对应关系：登记的文件缺失而同 pi session id 的
      //    文件存在（崩溃发生在路径回填前后窗口）时，采用最新一份，保证重启
      //    后继续写入同一份权威历史，而不是另起新文件。
      const sessionsDir = sessionsDirFor(this.config.dataDir);
      for (const session of store.listSessions()) {
        const recorded = session.sessionFile;
        const recordedOk = recorded !== null && fs.existsSync(recorded);
        if (recordedOk) continue;
        const candidates = fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith(`_${session.piSessionId}.jsonl`))
          .sort();
        const latest = candidates.at(-1);
        if (latest) {
          const found = path.join(sessionsDir, latest);
          store.setSessionFile(session.id, found);
          if (recorded !== null) {
            store.appendEvent(
              {
                type: "session.history_unreadable",
                sessionId: session.id,
                sessionFile: recorded,
                error: `登记的会话文件缺失，已改用同 session id 的 ${latest}`,
              },
              { sessionId: session.id },
            );
          }
        } else if (recorded !== null) {
          store.appendEvent(
            {
              type: "session.history_unreadable",
              sessionId: session.id,
              sessionFile: recorded,
              error: "登记的会话文件缺失且未找到同 session id 的历史文件",
            },
            { sessionId: session.id },
          );
        }
      }

      store.appendEvent(
        { type: "backend.recovered", interruptedTaskIds, pausedSessionIds },
      );
    });
  }

  // ---------- 项目与会话 ----------

  createProject(name: string): Project {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    if (!name.trim()) throw new RuntimeApiError("invalid_params", "项目名不能为空");
    return this.store.withTx(() => {
      if (this.store.findProjectByName(name)) {
        throw new RuntimeApiError("duplicate", `项目已存在：${name}`);
      }
      return this.store.createProject(name);
    });
  }

  async createSession(input: {
    projectId: string;
    cwd: string;
    confirmTools?: string[];
  }): Promise<Session> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新操作");
    const project = this.store.getProject(input.projectId);
    if (!project) throw new RuntimeApiError("not_found", `项目不存在：${input.projectId}`);
    const identity = await resolveDirIdentity(input.cwd).catch((err: DirIdentityError) =>
      Promise.reject(new RuntimeApiError("invalid_params", err.message)),
    );
    // 工作区不得是保护根（后台数据、凭据、控制面、服务代码）本身、其子级或其祖先
    try {
      assertGrantNotProtected(identity.cwdReal, this.protectedRoots());
    } catch (err) {
      throw new RuntimeApiError("invalid_params", `工作区不可用：${(err as Error).message}`);
    }
    return this.store.withTx(() =>
      this.store.createSession({
        projectId: input.projectId,
        cwd: identity.cwd,
        cwdReal: identity.cwdReal,
        cwdDev: identity.dev,
        cwdIno: identity.ino,
        piSessionId: randomUUID(),
        confirmTools: input.confirmTools ?? [],
      }),
    );
  }

  // ---------- 提交与排队 ----------

  /**
   * 校验拥有者为任务显式授予的工作区外路径：必须存在，且不得是保护根
   * （后台数据、凭据、控制面、服务代码）本身、其子级或其祖先。
   */
  private validateGrantedPaths(paths: GrantedPath[]): GrantedPath[] {
    const resolved: GrantedPath[] = [];
    for (const p of paths) {
      if (!p.path.trim()) throw new RuntimeApiError("invalid_params", "授予路径不能为空");
      if (p.access !== "read" && p.access !== "read_write") {
        throw new RuntimeApiError("invalid_params", `授予路径访问级别无效：${p.access}`);
      }
      let real: string;
      try {
        real = fs.realpathSync(p.path);
      } catch {
        throw new RuntimeApiError("invalid_params", `授予路径不存在：${p.path}`);
      }
      try {
        assertGrantNotProtected(real, this.protectedRoots());
      } catch (err) {
        throw new RuntimeApiError("invalid_params", (err as Error).message);
      }
      resolved.push({ path: real, access: p.access, purpose: p.purpose || "未说明" });
    }
    return resolved;
  }

  /**
   * worktree 的共享 Git 元数据在工作区之外：授予路径覆盖它时在用途中展示
   * 共享影响（不自动挂载主仓库或父目录——只有拥有者显式给出的路径进入边界）。
   */
  private annotateSharedGitMetadata(cwdReal: string, granted: GrantedPath[]): GrantedPath[] {
    const commonGitDir = resolveWorktreeCommonGitDir(cwdReal);
    if (!commonGitDir) return granted;
    return granted.map((p) =>
      grantCoversPath(p.path, commonGitDir) && !p.purpose.includes("共享 Git 元数据")
        ? { ...p, purpose: `${p.purpose}（共享 Git 元数据：${commonGitDir}）` }
        : p,
    );
  }

  submit(input: {
    sessionId: string;
    requestId: string;
    input: string;
    accessMode?: AccessMode;
    grantedPaths?: GrantedPath[];
    resumesTaskId?: string;
  }): Task {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (!input.input.trim()) throw new RuntimeApiError("invalid_params", "输入不能为空");
    const accessMode = input.accessMode ?? "confirm";
    if (accessMode !== "confirm" && accessMode !== "full_access") {
      throw new RuntimeApiError("invalid_params", `访问模式无效：${accessMode}`);
    }
    // 所选模式的执行入口必须可用（缺少后端/身份配置时明确失败，不回退）
    try {
      this.launcherFor(accessMode);
    } catch (err) {
      const code = err instanceof ExecutionError ? err.code : "execution_unavailable";
      throw new RuntimeApiError(code, `${accessMode} 模式的执行入口不可用：${(err as Error).message}`);
    }
    const grantedPaths = this.annotateSharedGitMetadata(
      session.cwdReal,
      this.validateGrantedPaths(input.grantedPaths ?? []),
    );

    let task: Task;
    let duplicate: boolean;
    try {
      ({ task, duplicate } = this.store.withTx(() =>
        this.store.insertQueuedTask({
          sessionId: input.sessionId,
          requestId: input.requestId,
          input: input.input,
          accessMode,
          grantedPaths,
          resumesTaskId: input.resumesTaskId,
        }),
      ));
    } catch (err) {
      if (err instanceof StoreConflictError) {
        throw new RuntimeApiError(err.code, err.message);
      }
      throw err;
    }
    if (!duplicate) this.kick(input.sessionId);
    return task;
  }

  /**
   * 中断任务的人工继续：新任务带 resumes_task_id；不自动重放任何执行。
   * 新任务默认请求确认；旧批准不继承，拥有者可在提交时重新明确选择
   * 完全访问。
   */
  continueTask(input: { taskId: string; requestId: string; input: string; accessMode?: AccessMode; grantedPaths?: GrantedPath[] }): Task {
    const old = this.store.getTask(input.taskId);
    if (!old) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (old.status !== "interrupted") {
      throw new RuntimeApiError("invalid_state", `只能继续已中断的任务，当前状态 ${old.status}`);
    }
    return this.submit({
      sessionId: old.sessionId,
      requestId: input.requestId,
      input: input.input,
      accessMode: input.accessMode ?? "confirm",
      grantedPaths: input.grantedPaths,
      resumesTaskId: old.id,
    });
  }

  /**
   * 拥有者显式切换任务访问模式（完全访问只能由此入口或提交参数选择）。
   * - queued/awaiting_confirmation（无执行中工具）：立即应用——停止并核实
   *   旧执行单元退出后落库；awaiting 的等待审批一并失效；
   * - running（工具执行中）：登记待生效模式，在下一个工具边界应用；
   *   执行中的调用继续使用开始时的范围；需要立即停止请用中断。
   */
  async switchTaskMode(input: { taskId: string; mode: AccessMode; grantedPaths?: GrantedPath[] }): Promise<Task> {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝模式切换");
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (input.mode !== "confirm" && input.mode !== "full_access") {
      throw new RuntimeApiError("invalid_params", `访问模式无效：${input.mode}`);
    }
    if (task.accessMode === input.mode && !input.grantedPaths) {
      throw new RuntimeApiError("invalid_state", `任务已是 ${input.mode} 模式`);
    }
    // 目标模式的执行入口必须可用（明确失败，不回退）
    try {
      this.launcherFor(input.mode);
    } catch (err) {
      const code = err instanceof ExecutionError ? err.code : "execution_unavailable";
      throw new RuntimeApiError(code, `目标模式的执行入口不可用：${(err as Error).message}`);
    }
    if (input.grantedPaths) {
      this.validateGrantedPaths(input.grantedPaths);
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new RuntimeApiError("invalid_state", `任务已结束（${task.status}），不能切换模式`);
    }
    if (task.status === "queued" || task.status === "awaiting_confirmation") {
      // 无执行中工具的边界：立即应用
      const driver = this.drivers.get(task.sessionId);
      const reaped = driver ? await driver.router.stopWorker() : true;
      if (!reaped) {
        // 无法核实旧执行单元退出：任务中断、占用保留（不可安全继续）
        this.store.withTx(() => {
          if (this.store.transitionTask(task.id, ["queued", "running", "awaiting_confirmation"], "interrupted", {
            interruptReason: "mode_switch_unverified",
            endedAt: new Date().toISOString(),
          })) {
            this.store.stalePendingConfirmations(task.id);
            this.store.appendEvent(
              { type: "task.mode_switch_failed", taskId: task.id, sessionId: task.sessionId, to: input.mode, reason: "无法核实旧执行单元已退出" },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
        throw new RuntimeApiError("mode_switch_unverified", "无法核实旧执行单元已退出，任务已中断（占用保留待核实）");
      }
      this.store.withTx(() => {
        let version = task.permissionVersion;
        if (input.grantedPaths) {
          const session = this.store.getSession(task.sessionId)!;
          const annotated = this.annotateSharedGitMetadata(session.cwdReal, this.validateGrantedPaths(input.grantedPaths));
          version = this.store.updateGrantedPaths(task.id, annotated);
        }
        version = this.store.applyModeSwitch(task.id, input.mode);
        this.store.appendEvent(
          { type: "task.mode_switched", taskId: task.id, sessionId: task.sessionId, from: task.accessMode, to: input.mode, permissionVersion: version },
          { taskId: task.id, sessionId: task.sessionId },
        );
      });
      if (driver && task.status === "awaiting_confirmation") {
        driver.supersedeWaiters();
      }
      return this.store.getTask(task.id)!;
    }
    // running：登记待生效，工具边界处应用
    this.store.withTx(() => {
      if (this.store.requestModeSwitch(task.id, input.mode)) {
        this.store.appendEvent(
          { type: "task.mode_switch_requested", taskId: task.id, sessionId: task.sessionId, from: task.accessMode, to: input.mode },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
    return this.store.getTask(task.id)!;
  }

  // ---------- 审批 / 产物 / 凭据 ----------

  /**
   * 拥有者查询任务产物正文（按 id、偏移、长度）。宿主依据任务归属查找，
   * 不接受任意宿主路径，不跨任务返回正文。
   */
  queryArtifact(input: { taskId: string; artifactId: string; offset?: number; length?: number }): { artifact: Artifact; encoding: "base64"; data: string } {
    const task = this.store.getTask(input.taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    const artifact = this.store.getArtifact(input.artifactId);
    if (!artifact || artifact.taskId !== input.taskId) {
      throw new RuntimeApiError("not_found", `产物不存在或不属于该任务：${input.artifactId}`);
    }
    const offset = Math.max(0, input.offset ?? 0);
    const length = Math.min(Math.max(1, input.length ?? 256 * 1024), 1024 * 1024);
    const buf = this.artifacts.read(artifact.id, offset, length);
    return { artifact, encoding: "base64", data: buf.toString("base64") };
  }

  listCredentialBindings() {
    return this.credentials.list();
  }

  addCredentialBinding(input: { name: string; host: string; header: string; purpose: string; secret: string }) {
    if (!input.name.trim() || !input.host.trim() || !input.header.trim() || !input.secret) {
      throw new RuntimeApiError("invalid_params", "凭据绑定的名称、主机、头与秘密值都不能为空");
    }
    this.credentials.upsert({ ...input, host: input.host.toLowerCase() });
    return { name: input.name, host: input.host.toLowerCase(), header: input.header, purpose: input.purpose };
  }

  removeCredentialBinding(name: string): boolean {
    return this.credentials.remove(name);
  }

  // ---------- 调度 ----------

  private kick(sessionId: string): void {
    if (this.stopping) return;
    if (this.loopActive.has(sessionId)) {
      this.wakePending.add(sessionId);
      return;
    }
    this.loopActive.add(sessionId);
    const loop = this.runQueueLoop(sessionId).finally(() => {
      this.loopActive.delete(sessionId);
      this.loopPromises.delete(sessionId);
      if (this.wakePending.delete(sessionId)) this.kick(sessionId);
    });
    this.loopPromises.set(sessionId, loop);
    void loop;
  }

  /** 占用释放或队列恢复时唤醒所有会话（等待同目录的排队任务重新尝试）。 */
  private kickAll(): void {
    for (const session of this.store.listSessions()) {
      if (this.store.listQueuedTasksFifo(session.id).length > 0) this.kick(session.id);
    }
  }

  private async runQueueLoop(sessionId: string): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const session = this.store.getSession(sessionId);
      if (!session || session.queueState !== "active") return;
      const task = this.store.listQueuedTasksFifo(sessionId)[0];
      if (!task) return;

      // 任务开始前核对目录身份：排队期间被替换或失效的目录拒绝执行
      try {
        await verifyDirIdentity({
          cwd: session.cwd,
          cwdReal: session.cwdReal,
          dev: session.cwdDev,
          ino: session.cwdIno,
        });
      } catch (err) {
        this.store.withTx(() => {
          const ok = this.store.transitionTask(task.id, ["queued"], "failed", {
            errorMessage: (err as Error).message,
            endedAt: new Date().toISOString(),
          });
          if (ok) {
            this.store.appendEvent(
              { type: "task.failed", taskId: task.id, sessionId, errorMessage: (err as Error).message },
              { taskId: task.id, sessionId },
            );
          }
        });
        continue; // 该会话其余任务共用同一目录，同样会被拒绝
      }

      try {
        this.store.withTx(() => {
          if (this.stopping) throw new TaskGoneError(); // 停止开始后不再让排队任务转入运行
          if (!this.store.tryAcquireOccupancy({
            cwdReal: session.cwdReal,
            cwdDev: session.cwdDev,
            cwdIno: session.cwdIno,
            sessionId,
            taskId: task.id,
          })) {
            throw new DirOccupiedError();
          }
          if (!this.store.transitionTask(task.id, ["queued"], "running", { startedAt: new Date().toISOString() })) {
            throw new TaskGoneError();
          }
          this.store.appendEvent(
            { type: "task.started", taskId: task.id, sessionId },
            { taskId: task.id, sessionId },
          );
        });
      } catch (err) {
        if (err instanceof DirOccupiedError) return; // 等待占用释放后的唤醒
        if (err instanceof TaskGoneError) continue; // 已被取消或后台停止，取下一个
        throw err;
      }

      const driver = await this.getDriver(session);
      const fresh = this.store.getTask(task.id)!;
      try {
        await driver.run(fresh);
      } catch (err) {
        // driver.run 内部已兜底；此处防御性记录，避免调度循环中断
        this.store.withTx(() => {
          this.store.transitionTask(task.id, ["running", "awaiting_confirmation"], "failed", {
            errorMessage: `驱动器异常：${(err as Error).message}`,
            endedAt: new Date().toISOString(),
          });
          this.store.appendEvent(
            { type: "task.failed", taskId: task.id, sessionId, errorMessage: (err as Error).message },
            { taskId: task.id, sessionId },
          );
          this.store.releaseOccupancy(session.cwdReal, task.id);
        });
      } finally {
        this.kickAll();
      }
    }
  }

  private async getDriver(session: Session): Promise<Driver> {
    let driver = this.drivers.get(session.id);
    if (!driver) {
      driver = new Driver(session, {
        store: this.store,
        sessionsDir: sessionsDirFor(this.config.dataDir),
        agentDir: this.config.agentDir,
        modelRuntime: this.modelRuntime,
        model: this.model,
        thinkingLevel: this.config.thinkingLevel ?? "off",
        toolFactory:
          this.config.toolFactory ??
          ((ctx) => createCodingTools(ctx.router)),
        artifacts: this.artifacts,
        credentials: this.credentials,
        launcherFor: (mode) => this.launcherFor(mode),
        protectedRoots: this.protectedRoots(),
        onOccupancyReleased: () => this.kickAll(),
      });
      this.drivers.set(session.id, driver);
    } else {
      // 会话记录可能更新（如 sessionFile 落盘后回填）
      driver.syncSessionRecord(session);
    }
    return driver;
  }

  // ---------- 中断 / 取消 / 确认 / 恢复队列 ----------

  async interruptTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    if (task.status !== "running" && task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("invalid_state", `只能中断运行中或等待确认的任务，当前 ${task.status}`);
    }
    const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
    await driver.requestStop(task, { terminal: "interrupted", reason: "owner_interrupt", cancelIntent: false });
    return this.store.getTask(taskId)!;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const task = this.store.getTask(taskId);
    if (!task) throw new RuntimeApiError("not_found", `任务不存在：${taskId}`);
    if (task.status === "queued") {
      this.store.withTx(() => {
        const ok = this.store.transitionTask(task.id, ["queued"], "canceled", {
          endedAt: new Date().toISOString(),
        });
        if (ok) {
          this.store.appendEvent(
            { type: "task.canceled", taskId: task.id, sessionId: task.sessionId },
            { taskId: task.id, sessionId: task.sessionId },
          );
        }
      });
      return this.store.getTask(taskId)!;
    }
    if (task.status === "running" || task.status === "awaiting_confirmation") {
      const driver = await this.getDriver(this.store.getSession(task.sessionId)!);
      await driver.requestStop(task, { terminal: "canceled", reason: "owner_cancel", cancelIntent: true });
      return this.store.getTask(taskId)!;
    }
    throw new RuntimeApiError("invalid_state", `任务已结束（${task.status}），不能取消`);
  }

  respondConfirmation(confirmationId: string, decision: "approved" | "rejected"): ConfirmationRequest {
    const confirmation = this.store.getConfirmation(confirmationId);
    if (!confirmation) throw new RuntimeApiError("not_found", `确认请求不存在：${confirmationId}`);
    const task = this.store.getTask(confirmation.taskId)!;
    if (task.status !== "awaiting_confirmation") {
      throw new RuntimeApiError("stale_confirmation", `确认请求已失效（任务状态 ${task.status}）`);
    }
    const driver = this.drivers.get(confirmation.sessionId);
    if (!driver) throw new RuntimeApiError("stale_confirmation", "确认请求已失效（无活动执行）");
    const applied = driver.resolveConfirmation(confirmationId, decision);
    if (!applied) throw new RuntimeApiError("stale_confirmation", "确认请求已被处理或失效");
    return this.store.getConfirmation(confirmationId)!;
  }

  /** 拥有者确认旧执行已停止：释放该会话遗留占用并恢复队列。 */
  resumeQueue(sessionId: string): Session {
    const session = this.store.getSession(sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${sessionId}`);
    this.store.withTx(() => {
      // 仅释放遗留（所属任务已结束）的占用；活动任务持有的占用不得被此操作破坏
      for (const occ of this.store.listAllOccupancy()) {
        if (occ.sessionId !== sessionId) continue;
        const occTask = this.store.getTask(occ.taskId);
        if (occTask && !isTerminalTaskStatus(occTask.status)) {
          throw new RuntimeApiError(
            "occupancy_active",
            `任务 ${occ.taskId} 仍在 ${occTask.status}，占用不能释放`,
          );
        }
        this.store.releaseOccupancy(occ.cwdReal, occ.taskId);
      }
      this.store.setSessionQueueState(sessionId, "active", null);
      this.store.appendEvent({ type: "session.queue_resumed", sessionId }, { sessionId });
    });
    this.kick(sessionId);
    return this.store.getSession(sessionId)!;
  }

  // ---------- 快照 ----------

  snapshot(): {
    projects: Project[];
    sessions: Session[];
    tasks: Task[];
    confirmations: ConfirmationRequest[];
    artifacts: Artifact[];
    seq: number;
  } {
    return {
      projects: this.store.listProjects(),
      sessions: this.store.listSessions(),
      tasks: this.store.listTasksByStatus([
        "queued",
        "running",
        "awaiting_confirmation",
        "completed",
        "failed",
        "canceled",
        "interrupted",
      ]),
      confirmations: this.store.listConfirmationsByStatus("pending"),
      artifacts: this.listRecentArtifacts(),
      seq: this.store.getMaxSeq(),
    };
  }

  /** 活动任务与最近结束任务的产物元数据（正文在产物文件，按 id 查询）。 */
  private listRecentArtifacts(): Artifact[] {
    const active = this.store.listTasksByStatus(["queued", "running", "awaiting_confirmation"]);
    const ids = new Set<string>();
    const out: Artifact[] = [];
    for (const task of active) {
      for (const artifact of this.store.listArtifactsByTask(task.id)) {
        if (!ids.has(artifact.id)) {
          ids.add(artifact.id);
          out.push(artifact);
        }
      }
    }
    return out;
  }

  /** 单任务详情：任务、工具操作、确认请求（含完整参数与权限范围）、产物。 */
  getTaskDetail(taskId: string): { task: Task; toolOps: ToolOp[]; confirmations: ConfirmationRequest[]; artifacts: Artifact[] } | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      toolOps: this.store.listToolOpsByTask(task.id),
      confirmations: this.store.listConfirmationsByTask(task.id),
      artifacts: this.store.listArtifactsByTask(task.id),
    };
  }

  getEventLog(afterSeq: number, limit?: number): PersistentEvent[] {
    return this.store.getEventsAfter(afterSeq, limit);
  }

  // ---------- 停止 ----------

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private async doStop(reason: string): Promise<void> {
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopping", reason });
    });

    // 中断活动任务（queued 保留）；requestStop 内部完成终态、占用与事件
    const active = this.store.listTasksByStatus(ACTIVE_TASK_STATUSES.filter((s) => s !== "queued"));
    const driverOf = (task: Task) => this.drivers.get(task.sessionId);
    for (const task of active) {
      const driver = driverOf(task);
      if (driver) {
        await driver.requestStop(task, {
          terminal: "interrupted",
          reason: "backend_stop",
          cancelIntent: false,
        }).catch(() => {});
      } else {
        // 已占用运行中但驱动器缺失（异常路径）：条件更新中断并保留占用事实
        this.store.withTx(() => {
          if (this.store.transitionTask(task.id, ["running", "awaiting_confirmation"], "interrupted", {
            interruptReason: "backend_stop",
            endedAt: new Date().toISOString(),
          })) {
            this.store.stalePendingConfirmations(task.id);
            this.store.appendEvent(
              { type: "task.interrupted", taskId: task.id, sessionId: task.sessionId, reason: "backend_stop", cancelRequested: false, effectUnknown: false },
              { taskId: task.id, sessionId: task.sessionId },
            );
          }
        });
      }
    }

    for (const driver of this.drivers.values()) {
      await driver.dispose();
    }
    this.drivers.clear();

    // 等待调度循环收尾（停止意图已在上面使 runQueueLoop 退出），
    // 之后才能关闭数据库，避免循环尾部访问已关闭的连接
    while (this.loopPromises.size > 0) {
      await Promise.allSettled(Array.from(this.loopPromises.values()));
    }

    if (this.onCloseServer) {
      await this.onCloseServer().catch(() => {});
    }
    this.store.withTx(() => {
      this.store.appendEvent({ type: "backend.stopped", reason });
    });
    this.db.close();
    this.lock.release();
    try {
      fs.rmSync(this.socketPath(), { force: true });
    } catch {
      // socket 清理失败不阻断退出
    }
  }
}
