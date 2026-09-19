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
import { Store, StoreConflictError } from "../core/store.ts";
import {
  ACTIVE_TASK_STATUSES,
  isTerminalTaskStatus,
  type ConfirmationRequest,
  type PersistentEvent,
  type Project,
  type Session,
  type Task,
  randomId,
} from "../core/types.ts";
import { acquireInstanceLock, type AcquiredLock } from "../core/instance-lock.ts";
import { resolveDirIdentity, verifyDirIdentity, DirIdentityError } from "../core/dir-identity.ts";
import { Driver } from "../agent/driver.ts";
import { createMockTools } from "../agent/mock-tools.ts";
import { sessionsDirFor } from "../agent/session-factory.ts";

export interface RuntimeConfig {
  dataDir: string;
  /** pi 凭据与模型配置目录（显式指定，不读 ~/.pi/agent）。 */
  agentDir: string;
  socketPath?: string;
  thinkingLevel?: "off" | "minimal" | "medium" | "high" | "xhigh";
  /** 默认取 models.json 的第一个模型；可显式指定 provider/id。 */
  modelProvider?: string;
  modelId?: string;
  /** 默认使用模拟工具；真实编码工具由 issue 03 沿用同一执行路径接入。 */
  toolFactory?: (ctx: { registry: import("../agent/managed-processes.ts").ManagedProcessRegistry }) => ToolDefinition[];
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
    store.onCommitted = (events) => this.onEventBroadcast?.(events);
  }

  static async start(config: RuntimeConfig): Promise<Runtime> {
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.agentDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDirFor(config.dataDir), { recursive: true, mode: 0o700 });

    const lock = acquireInstanceLock(config.dataDir);
    let runtime: Runtime;
    try {
      const db = new Db(config.dataDir);
      const store = new Store(db);
      runtime = new Runtime(config, db, store, lock);
    } catch (err) {
      lock.release();
      throw err;
    }

    runtime.modelRuntime = await ModelRuntime.create({
      authPath: path.join(config.agentDir, "auth.json"),
      modelsPath: path.join(config.agentDir, "models.json"),
      modelsStore: new InMemoryModelsStore(),
      refreshOnCreate: false,
    });
    const model = await resolveConfiguredModel(runtime, config);
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
      runtime.store.appendEvent({ type: "backend.started", dataDir: config.dataDir });
    });
    return runtime;
  }

  socketPath(): string {
    return this.config.socketPath ?? path.join(this.config.dataDir, "control.sock");
  }

  // ---------- 恢复 ----------

  private recover(): void {
    // 恢复是一次逻辑事务：任务中断、确认失效、占用事实、队列暂停与恢复
    // 事件要么全部提交，要么整体回滚，不留半恢复状态
    this.store.withTx(() => {
      const store = this.store;
      const interruptedTaskIds: string[] = [];
      const pausedSessionIds: string[] = [];

      // 1. 未完成执行 → interrupted；结果缺失的工具操作保留 effect_unknown 事实
      for (const task of store.listTasksByStatus(["running", "awaiting_confirmation"])) {
        const unresolved = store.listUnresolvedToolOps(task.id);
        for (const op of unresolved) {
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
          if (unresolved.length > 0) store.setEffectUnknown(task.id);
          store.stalePendingConfirmations(task.id);
          store.appendEvent(
            {
              type: "task.interrupted",
              taskId: task.id,
              sessionId: task.sessionId,
              reason: "backend_restart",
              cancelRequested: task.cancelRequested,
              effectUnknown: unresolved.length > 0,
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

  submit(input: { sessionId: string; requestId: string; input: string; resumesTaskId?: string }): Task {
    if (this.stopping) throw new RuntimeApiError("stopping", "后台正在停止，拒绝新任务");
    const session = this.store.getSession(input.sessionId);
    if (!session) throw new RuntimeApiError("not_found", `会话不存在：${input.sessionId}`);
    if (!input.requestId) throw new RuntimeApiError("invalid_params", "request_id 不能为空");
    if (!input.input.trim()) throw new RuntimeApiError("invalid_params", "输入不能为空");

    let task: Task;
    let duplicate: boolean;
    try {
      ({ task, duplicate } = this.store.withTx(() =>
        this.store.insertQueuedTask({
          sessionId: input.sessionId,
          requestId: input.requestId,
          input: input.input,
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

  /** 中断任务的人工继续：新任务带 resumes_task_id；不自动重放任何执行。 */
  continueTask(input: { taskId: string; requestId: string; input: string }): Task {
    const old = this.store.getTask(input.taskId);
    if (!old) throw new RuntimeApiError("not_found", `任务不存在：${input.taskId}`);
    if (old.status !== "interrupted") {
      throw new RuntimeApiError("invalid_state", `只能继续已中断的任务，当前状态 ${old.status}`);
    }
    return this.submit({
      sessionId: old.sessionId,
      requestId: input.requestId,
      input: input.input,
      resumesTaskId: old.id,
    });
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
        toolFactory: this.config.toolFactory ?? ((ctx) => createMockTools(ctx)),
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

  snapshot(): { projects: Project[]; sessions: Session[]; tasks: Task[]; confirmations: ConfirmationRequest[]; seq: number } {
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
      seq: this.store.getMaxSeq(),
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
