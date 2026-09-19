/**
 * 会话驱动器：把 SDK 会话接到任务状态机上。
 *
 * 职责：
 * - 懒创建 SDK 会话（封闭配置见 session-factory）；
 * - 运行任务：标记条目关联（task_start/task_end marker）→ prompt → 依据
 *   最终 assistant 消息与落盘核对确定终态（条件更新保证取消/完成竞争下
 *   只有一个终态）；
 * - tool_call 门：记录执行意图；需要确认的工具阻塞等待拥有者应答；
 * - 片段与条目引用：流式片段按 partial 事件发出；条目引用只在读文件确认
 *   落盘后发出（不预支未落盘内容，不建第二套权威历史）；
 * - 停止路径：先提交停止意图，解除确认等待，abort()，回收受管进程组，
 *   之后才提交终态并释放占用；
 * - 上下文超限：检测后任务中断（context_overflow）并暂停该会话队列，
 *   不自动摘要、不重试。
 */

import * as fs from "node:fs";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { isContextOverflow } from "@earendil-works/pi-ai/compat";
import type { Session, Task } from "../core/types.ts";
import type { Store } from "../core/store.ts";
import { killProcessGroup, type ManagedProcessRegistry, createManagedProcessRegistry } from "./managed-processes.ts";
import { createSdkSession } from "./session-factory.ts";

const TASK_START_MARKER = "ruukoto_task_start";
const TASK_END_MARKER = "ruukoto_task_end";
const FRAGMENT_INTERVAL_MS = 250;

export interface DriverDeps {
  store: Store;
  sessionsDir: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: any;
  thinkingLevel: "off" | "minimal" | "medium" | "high" | "xhigh";
  toolFactory: (ctx: { registry: ManagedProcessRegistry }) => ToolDefinition[];
  /** 占用释放后的唤醒回调（Runtime 注入，用于调度等待同目录的会话）。 */
  onOccupancyReleased: () => void;
}

export class Driver {
  readonly session: Session;
  private readonly deps: DriverDeps;
  private sdk: AgentSession | null = null;
  private registry: ManagedProcessRegistry;
  private currentTask: Task | null = null;
  private stopRequested = false;
  private confirmationWaiters = new Map<string, (decision: "approved" | "rejected" | "canceled") => void>();
  private pendingConfirmationCount = 0;
  private flushedEntryIds = new Set<string>();
  private lastFragmentAt = 0;
  private runPromise: Promise<void> | null = null;
  /** SDK 扩展桥注入的 appendEntry（宿主标记条目，custom，不进模型上下文）。 */
  private markerApi: ((customType: string, data: unknown) => void) | null = null;

  constructor(session: Session, deps: DriverDeps) {
    this.session = session;
    this.deps = deps;
    this.registry = createManagedProcessRegistry();
  }

  get busy(): boolean {
    return this.currentTask !== null;
  }

  get currentTaskId(): string | null {
    return this.currentTask?.id ?? null;
  }

  /** 会话记录更新后同步（如 sessionFile 落盘回填）。 */
  syncSessionRecord(latest: Session): void {
    this.session.sessionFile = latest.sessionFile;
    this.session.queueState = latest.queueState;
    this.session.confirmTools = latest.confirmTools;
  }

  private async ensureSdk(): Promise<AgentSession> {
    if (this.sdk) return this.sdk;
    this.sdk = await createSdkSession({
      session: this.session,
      sessionsDir: this.deps.sessionsDir,
      agentDir: this.deps.agentDir,
      modelRuntime: this.deps.modelRuntime,
      model: this.deps.model,
      thinkingLevel: this.deps.thinkingLevel,
      tools: this.deps.toolFactory({ registry: this.registry }),
      hooks: {
        onToolCall: (event) => this.handleToolCall(event),
        onSessionEvent: (event) => this.handleSessionEvent(event),
        bindHostApi: (api) => {
          this.markerApi = api.appendEntry;
        },
      },
    });
    return this.sdk;
  }

  private appendMarker(customType: string, data: unknown): void {
    // SDK 会话创建前标记 API 不可用；此时代码路径不应产生标记
    this.markerApi?.(customType, data);
  }

  // ---------- 运行 ----------

  async run(task: Task): Promise<void> {
    if (this.runPromise) {
      throw new Error(`会话 ${this.session.id} 已有任务在运行`);
    }
    this.currentTask = task;
    this.stopRequested = false;
    this.flushedEntryIds = new Set();
    this.registry.clear();
    this.runPromise = this.runInner(task);
    try {
      await this.runPromise;
    } finally {
      this.runPromise = null;
      this.currentTask = null;
    }
  }

  private async runInner(task: Task): Promise<void> {
    let sdk: AgentSession;
    try {
      sdk = await this.ensureSdk();
    } catch (err) {
      this.finalize(task, "failed", { errorMessage: `SDK 会话创建失败：${(err as Error).message}` });
      return;
    }

    // 会话文件路径尽早落库：崩溃后重启才能打开同一份 JSONL 而不是另起新文件
    const currentFile = sdk.sessionFile;
    if (currentFile && currentFile !== this.session.sessionFile) {
      this.deps.store.withTx(() => {
        this.deps.store.setSessionFile(this.session.id, currentFile);
        this.session.sessionFile = currentFile;
      });
    }

    if (this.stopRequested) {
      // 停止意图先于 prompt 到达：直接进入中断终态（条件更新仲裁竞争）
      await this.killManagedProcesses();
      this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    this.appendMarker(TASK_START_MARKER, { taskId: task.id, requestId: task.requestId });
    try {
      await sdk.prompt(task.input);
    } catch (err) {
      if (!this.stopRequested) {
        this.finalize(task, "failed", { errorMessage: (err as Error).message });
      }
      await this.killManagedProcesses();
      return;
    }

    await this.killManagedProcesses();
    if (this.stopRequested) {
      // requestStop 拥有终态；这里只做清理
      return;
    }

    const lastAssistant = findLastAssistant(sdk.messages as any[]);
    const stopReason: string = lastAssistant?.stopReason ?? "error";

    if (stopReason === "aborted") {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "aborted" });
      this.finalize(task, "interrupted", { interruptReason: "aborted" });
      return;
    }

    const contextWindow: number = this.deps.model?.contextWindow ?? 0;
    if (lastAssistant && isContextOverflow(lastAssistant, contextWindow)) {
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "interrupted", reason: "context_overflow" });
      this.pauseQueue("context_overflow");
      this.finalize(task, "interrupted", { interruptReason: "context_overflow" });
      return;
    }

    if (stopReason === "error") {
      const message = lastAssistant?.errorMessage ?? "模型返回错误";
      this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "failed" });
      this.finalize(task, "failed", { errorMessage: message });
      return;
    }

    // 自然完成：先写入任务结束标记（它本身就是"历史已写完"的证据），
    // 再核对最终历史确实落盘，最后宣布 completed
    this.appendMarker(TASK_END_MARKER, { taskId: task.id, status: "completed" });
    const verification = this.verifyAndLinkHistory(task);
    if (verification.ok) {
      this.finalize(task, "completed", {});
    } else {
      this.finalize(task, "interrupted", { interruptReason: verification.reason! });
    }
  }

  // ---------- 停止路径（interrupt / cancel / 后台停止共用） ----------

  /**
   * 显式停止当前执行。顺序：提交停止意图 → 解除确认等待 → abort() →
   * 回收受管进程组 → 条件更新终态并释放占用。与自然完成竞争时条件更新
   * 保证只有一个终态生效。
   */
  async requestStop(
    task: Task,
    opts: { terminal: "canceled" | "interrupted"; reason: string; cancelIntent: boolean },
  ): Promise<boolean> {
    if (this.currentTask?.id !== task.id) return false;
    this.stopRequested = true;

    // 1. 提交停止意图（独立事务持久化）
    this.deps.store.withTx(() => {
      this.deps.store.setCancelRequested(task.id, opts.cancelIntent);
    });

    // 2. 解除确认等待（门以 block 结束，不执行该操作）
    for (const resolve of this.confirmationWaiters.values()) resolve("canceled");
    this.confirmationWaiters.clear();

    // 3. 中止模型调用与确认等待；受管工具进程组的终止与 abort 并行进行：
    //    abort() 会等待在执行的工具返回，若工具在等待子进程退出，必须同时
    //    回收进程组（TERM → 超时 KILL）才能解除等待，否则互相死锁。
    const abortPromise = this.sdk?.isStreaming ? this.sdk.abort().catch(() => {}) : null;
    const reaped = await this.killManagedProcesses();
    if (abortPromise) await abortPromise;

    // 4. 终态与占用释放（仅当尚未被自然完成抢先）
    const unresolved = this.deps.store.listUnresolvedToolOps(task.id);
    this.finalize(task, opts.terminal, {
      interruptReason: opts.reason,
      extraEffectUnknown: unresolved.length > 0,
      keepOccupancy: !reaped,
      occupancyIssueReason: reaped ? null : "tool_process_unreaped",
    });
    return reaped;
  }

  private async killManagedProcesses(): Promise<boolean> {
    const processes = this.registry.list();
    if (processes.length === 0) return true;
    let allReaped = true;
    for (const proc of processes) {
      const ok = await killProcessGroup(proc.pid);
      if (!ok) allReaped = false;
    }
    this.registry.clear();
    return allReaped;
  }

  // ---------- 终态与占用 ----------

  private finalize(
    task: Task,
    to: "completed" | "failed" | "canceled" | "interrupted",
    extra: {
      interruptReason?: string;
      errorMessage?: string;
      extraEffectUnknown?: boolean;
      keepOccupancy?: boolean;
      occupancyIssueReason?: string | null;
    },
  ): void {
    this.deps.store.withTx(() => {
      const store = this.deps.store;
      const ok = store.transitionTask(task.id, ["running", "awaiting_confirmation"], to, {
        interruptReason: extra.interruptReason ?? null,
        errorMessage: extra.errorMessage ?? null,
        endedAt: new Date().toISOString(),
      });
      if (!ok) return; // 已被竞争路径定态

      if (extra.extraEffectUnknown) {
        for (const op of store.listUnresolvedToolOps(task.id)) {
          store.markToolOpEffectUnknown(op.id);
          store.appendEvent(
            { type: "task.tool_effect_unknown", taskId: task.id, toolOpId: op.id, toolName: op.toolName },
            { taskId: task.id },
          );
        }
        store.setEffectUnknown(task.id);
      }

      // 中断/取消时清理未决确认（标记 stale，防止失效批准再执行）
      if (to === "interrupted" || to === "canceled") {
        store.stalePendingConfirmations(task.id);
      }

      const refs = { taskId: task.id, sessionId: task.sessionId };
      switch (to) {
        case "completed":
          store.appendEvent({ type: "task.completed", taskId: task.id, sessionId: task.sessionId }, refs);
          break;
        case "failed":
          store.appendEvent(
            { type: "task.failed", taskId: task.id, sessionId: task.sessionId, errorMessage: extra.errorMessage ?? "" },
            refs,
          );
          break;
        case "canceled":
          store.appendEvent({ type: "task.canceled", taskId: task.id, sessionId: task.sessionId }, refs);
          break;
        case "interrupted":
          store.appendEvent(
            {
              type: "task.interrupted",
              taskId: task.id,
              sessionId: task.sessionId,
              reason: extra.interruptReason ?? "unknown",
              cancelRequested: store.getTask(task.id)?.cancelRequested ?? false,
              effectUnknown: store.getTask(task.id)?.effectUnknown ?? false,
            },
            refs,
          );
          break;
      }

      if (extra.keepOccupancy) {
        // 无法确认旧执行已退出：保留占用并报错，不允许同目录新任务启动
        store.appendEvent(
          {
            type: "task.tool_process_unreaped",
            taskId: task.id,
            sessionId: task.sessionId,
            reason: extra.occupancyIssueReason ?? "unknown",
          },
          refs,
        );
      } else {
        store.releaseOccupancy(this.session.cwdReal, task.id);
      }
    });
    // 占用释放后唤醒其他会话的排队任务
    this.deps.onOccupancyReleased();
  }

  private pauseQueue(reason: string): void {
    this.deps.store.withTx(() => {
      this.deps.store.setSessionQueueState(this.session.id, "paused", reason);
      this.deps.store.appendEvent(
        { type: "session.queue_paused", sessionId: this.session.id, reason },
        { sessionId: this.session.id },
      );
    });
  }

  // ---------- tool_call 门 ----------

  private async handleToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const task = this.currentTask;
    if (!task) return undefined;
    const store = this.deps.store;

    const params = { ...(event.input as Record<string, unknown>) };
    store.withTx(() => {
      store.recordToolIntent({ id: event.toolCallId, taskId: task.id, toolName: event.toolName, params });
    });

    if (!this.session.confirmTools.includes(event.toolName)) {
      return undefined;
    }

    // 需要确认：登记请求、任务转入等待确认、阻塞到应答
    const confirmation = store.withTx(() => {
      const c = store.createConfirmation({
        taskId: task.id,
        sessionId: task.sessionId,
        toolOpId: event.toolCallId,
        toolName: event.toolName,
        params,
      });
      store.transitionTask(task.id, ["running"], "awaiting_confirmation", {});
      return c;
    });

    this.pendingConfirmationCount++;
    try {
      const decision = await new Promise<"approved" | "rejected" | "canceled">((resolve) => {
        this.confirmationWaiters.set(confirmation.id, resolve);
      });
      if (decision === "approved") return undefined;
      // 拒绝/取消：工具未执行，结果是已知的（不产生 effect_unknown）
      store.withTx(() => {
        const summary =
          decision === "rejected"
            ? `拥有者拒绝执行 ${event.toolName}`
            : `任务停止，确认等待解除（${event.toolName} 未执行）`;
        const recorded = store.recordToolResult(event.toolCallId, summary, true);
        if (recorded) {
          store.appendEvent(
            { type: "task.tool_result", taskId: task.id, toolOpId: event.toolCallId, summary, isError: true },
            { taskId: task.id },
          );
        }
      });
      if (decision === "rejected") {
        return { block: true, reason: `拥有者拒绝执行 ${event.toolName}` };
      }
      return { block: true, reason: "任务已停止，确认等待解除" };
    } finally {
      this.pendingConfirmationCount--;
      if (this.pendingConfirmationCount === 0) {
        store.withTx(() => {
          store.transitionTask(task.id, ["awaiting_confirmation"], "running", {});
        });
      }
    }
  }

  /** 控制面应答确认：条件更新 pending → approved/rejected；失效应答返回 false。 */
  resolveConfirmation(confirmationId: string, decision: "approved" | "rejected"): boolean {
    const waiter = this.confirmationWaiters.get(confirmationId);
    if (!waiter) return false;
    const store = this.deps.store;
    const applied = store.withTx(() => store.respondConfirmation(confirmationId, decision));
    if (!applied) return false;
    store.withTx(() => {
      const task = this.currentTask;
      if (task) {
        store.appendEvent(
          { type: "task.confirmation_resolved", taskId: task.id, confirmationId, decision },
          { taskId: task.id, sessionId: task.sessionId },
        );
      }
    });
    waiter(decision);
    return true;
  }

  // ---------- 会话事件观察 ----------

  private handleSessionEvent(event: AgentSessionEvent): void {
    const task = this.currentTask;
    if (!task) return;

    switch (event.type) {
      case "message_update": {
        // 流式片段：节流后按未完成输出发出（partial），不预支完整消息
        const now = Date.now();
        if (now - this.lastFragmentAt < FRAGMENT_INTERVAL_MS) return;
        this.lastFragmentAt = now;
        const text = extractText((event.message as any)?.content);
        if (text.length === 0) return;
        this.deps.store.withTx(() => {
          this.deps.store.appendEvent(
            { type: "task.output_fragment", taskId: task.id, sessionId: task.sessionId, text, partial: true },
            { taskId: task.id, sessionId: task.sessionId },
          );
        });
        return;
      }
      case "tool_execution_end": {
        const summary = summarizeToolResult(event.result);
        this.deps.store.withTx(() => {
          const recorded = this.deps.store.recordToolResult(event.toolCallId, summary, event.isError);
          if (recorded) {
            this.deps.store.appendEvent(
              { type: "task.tool_result", taskId: task.id, toolOpId: event.toolCallId, summary, isError: event.isError },
              { taskId: task.id },
            );
          }
        });
        return;
      }
      case "turn_end": {
        // 本轮消息已持久化（message_end 持久化先于 turn_end）；下一拍读文件补条目引用
        setImmediate(() => this.flushEntryRefs(task));
        return;
      }
      default:
        return;
    }
  }

  /** 读 JSONL，把本次任务尚未引用过的消息条目补发为 output_entry（先核实落盘）。 */
  private flushEntryRefs(task: Task): void {
    try {
      const file = this.sdk?.sessionFile;
      if (!file || !fs.existsSync(file)) return;
      const entries = parseSessionFile(file); // 解析失败抛错，不静默
      const startIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_START_MARKER && (e as any).data?.taskId === task.id,
      );
      if (startIdx === -1) return; // 首次落盘尚未包含标记
      for (let i = startIdx + 1; i < entries.length; i++) {
        const entry = entries[i] as any;
        if (entry.type === "custom" && entry.customType === TASK_END_MARKER && entry.data?.taskId === task.id) break;
        if (entry.type !== "message") continue;
        if (this.flushedEntryIds.has(entry.id)) continue;
        this.flushedEntryIds.add(entry.id);
        this.deps.store.withTx(() => {
          this.deps.store.addHistoryEntryIds(task.id, [entry.id]);
          this.deps.store.appendEvent(
            {
              type: "task.output_entry",
              taskId: task.id,
              sessionId: task.sessionId,
              entryId: entry.id,
              sessionFile: file,
              role: String(entry.message?.role ?? "unknown"),
            },
            { taskId: task.id, sessionId: task.sessionId },
          );
        });
      }
    } catch (err) {
      this.deps.store.withTx(() => {
        this.deps.store.appendEvent(
          {
            type: "session.history_unreadable",
            sessionId: this.session.id,
            sessionFile: this.sdk?.sessionFile ?? "unknown",
            error: (err as Error).message,
          },
          { sessionId: this.session.id },
        );
      });
    }
  }

  /** 任务完成前核对：JSONL 完整可解析、任务标记齐全，返回条目关联。 */
  private verifyAndLinkHistory(task: Task): { ok: boolean; reason?: string } {
    try {
      const file = this.sdk?.sessionFile;
      if (!file) return { ok: false, reason: "history_unverified:会话文件不存在" };
      this.deps.store.withTx(() => {
        const recorded = this.deps.store.getSession(this.session.id);
        if (recorded && recorded.sessionFile !== file) {
          this.deps.store.setSessionFile(this.session.id, file);
        }
      });
      const entries = parseSessionFile(file);
      const startIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_START_MARKER && (e as any).data?.taskId === task.id,
      );
      const endIdx = entries.findIndex(
        (e) => e.type === "custom" && (e as any).customType === TASK_END_MARKER && (e as any).data?.taskId === task.id,
      );
      if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return { ok: false, reason: "history_unverified:任务标记缺失（历史可能不完整）" };
      }
      const entryIds: string[] = [];
      for (let i = startIdx + 1; i < endIdx; i++) {
        const entry = entries[i] as any;
        if (entry.type === "message") entryIds.push(entry.id);
      }
      this.deps.store.withTx(() => {
        this.deps.store.addHistoryEntryIds(task.id, entryIds);
      });
      return { ok: true };
    } catch (err) {
      // 损坏的 JSONL：不覆盖、不忽略，要求人工处理
      this.deps.store.withTx(() => {
        this.deps.store.appendEvent(
          {
            type: "session.history_unreadable",
            sessionId: this.session.id,
            sessionFile: this.sdk?.sessionFile ?? "unknown",
            error: (err as Error).message,
          },
          { sessionId: this.session.id },
        );
      });
      return { ok: false, reason: "history_corrupted:JSONL 解析失败，保留原文件待人工处理" };
    }
  }

  async dispose(): Promise<void> {
    if (this.runPromise) await this.runPromise.catch(() => {});
    this.sdk?.dispose();
    this.sdk = null;
  }
}

// ---------- 辅助 ----------

function findLastAssistant(messages: any[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return undefined;
}

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("");
  }
  return "";
}

function summarizeToolResult(result: any): string {
  if (result === undefined || result === null) return "(no result)";
  if (typeof result === "string") return result.slice(0, 300);
  const text = extractText(result?.content);
  if (text.length > 0) return text.slice(0, 300);
  try {
    return JSON.stringify(result).slice(0, 300);
  } catch {
    return String(result).slice(0, 300);
  }
}

export interface ParsedSessionEntry {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** 严格解析 JSONL：任何一行损坏都抛错（不静默跳过、不覆盖原文件）。 */
export function parseSessionFile(file: string): ParsedSessionEntry[] {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line) as ParsedSessionEntry;
    } catch (err) {
      throw new Error(`会话文件第 ${i + 1} 行解析失败：${(err as Error).message}`);
    }
  });
}
