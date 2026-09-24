/**
 * main 的调度与通知宿主工具（issue 03）：schedule_create / query / cancel，
 * notification_enqueue / query / cancel。仅宿主引导的 main 角色会话装配。
 *
 * - 身份由宿主注入并在执行入口每次重核（任务/会话/项目/main 绑定）；
 * - 目标只来自可信宿主渠道配置；模型不能传入 URL、chat/user ID、凭据或审批 ID；
 * - 通知计划与一次确认发送都要拥有者确认（full_access 与 auto-review 也不例外）：
 *   审批固定完整正文、目标及配置版本、规则/时区/DST 与持续范围；获批后在同一
 *   核心事务中重核并消费批准、写入计划或发送操作；
 * - 正文可直接提交文本，或从已完成任务结果、可访问产物的文本片段、应用数据
 *   记录字段解析；登记前解析为最终文本并保存来源版本与摘要，之后业务数据变化
 *   不改变已批准正文；发送前复核可撤销的资料授权。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../core/store.ts";
import type { AccessScope } from "../core/access.ts";
import type { ApprovalScope, NotifyTarget, Task } from "../core/types.ts";
import type { ArtifactStore } from "./artifacts.ts";
import type { AppDataStore } from "./app-data/store.ts";
import type { ApprovalOutcome } from "./tool-router.ts";
import type { HostToolContext } from "./host-tools.ts";
import { describeRule, firstDue, parseRule, RuleError, tzDataVersion, type ScheduleRule } from "../scheduler/time.ts";
import { SchedulerConflictError, sha256, type NotificationOp, type Schedule, type SchedulerStore, type SourceRef } from "../scheduler/store.ts";
import { SCHEDULER_LIMITS, type Scheduler } from "../scheduler/runtime.ts";
import { QqStore } from "../qq/store.ts";
import { resolveAcceptedChatResult } from "./chat-result-tools.ts";

export const SCHEDULER_TOOL_NAMES = [
  "schedule_create",
  "schedule_query",
  "schedule_cancel",
  "notification_enqueue",
  "notification_query",
  "notification_cancel",
] as const;

/** 会登记记录的调度工具（恢复/停止时按宿主操作 ID 核实；query 只读）。 */
export const SCHEDULER_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "schedule_create",
  "schedule_cancel",
  "notification_enqueue",
  "notification_cancel",
]);

export const NOTIFY_LIMITS = {
  textChars: 2000,
  textBytes: 8 * 1024,
  noteBytes: 4 * 1024,
  sources: 8,
  paramsBytes: 32 * 1024,
  reasonBytes: 1024,
  createKeyChars: 128,
};

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * 恢复/停止路径共用：未落结果的调度工具操作按宿主操作 ID 核实——写工具已登记
 * 即已提交，未登记即已知未提交；只读查询无写入效果。调用方负责事务；
 * recordToolResult 条件更新保证重复恢复不重复发布。
 */
export function settleSchedulerOp(
  coreStore: Store,
  sched: SchedulerStore | null,
  task: { id: string; sessionId: string },
  op: { id: string; toolName: string },
  when: string,
): void {
  const summary = !SCHEDULER_WRITE_TOOL_NAMES.has(op.toolName)
    ? `已知未执行：只读查询在${when}未产生写入效果`
    : sched?.hostOpCommitted(op.id)
      ? `已提交：调度账本存在该操作记录（${when}已登记）`
      : `已知未提交：调度账本无该操作记录（${when}未登记）`;
  const isError = !summary.startsWith("已提交");
  if (coreStore.recordToolResult(op.id, summary, isError)) {
    coreStore.appendEvent(
      { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary, isError, artifactIds: [] },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }
}

// ---------- 来源快照 ----------

export interface SourceResolverDeps {
  store: Store;
  access: AccessScope;
  artifacts: ArtifactStore;
  appData(): AppDataStore | null;
}

/** main 读取资料的范围：本项目、main 委派的子任务，或有效资料授权覆盖的项目。 */
function mainCanRead(deps: SourceResolverDeps, mainProjectId: string, projectId: string, category: "history" | "artifact"): boolean {
  return deps.access.canAccess({ kind: "agent", projectId: mainProjectId }, projectId, category);
}

function taskReadable(deps: SourceResolverDeps, mainProjectId: string, task: Task): boolean {
  const project = deps.store.getSession(task.sessionId)?.projectId;
  // 父子关系只开放结果传递，不能把原始群资料变成 main 可读资料。
  if (!project || deps.access.isQqGroupProject(project)) return false;
  if (mainCanRead(deps, mainProjectId, project, "history")) return true;
  const parent = task.parentTaskId ? deps.store.getTask(task.parentTaskId) : null;
  return parent !== null && deps.store.getSession(parent.sessionId)?.projectId === mainProjectId;
}

export function createSourceResolver(deps: SourceResolverDeps) {
  const qq = new QqStore(deps.store.db);
  const resolveOne = (mainProjectId: string, raw: Record<string, unknown>): { text: string; ref: SourceRef } => {
    const kind = raw.kind;
    if (kind === "text") {
      if (typeof raw.text !== "string") throw new Error("text 来源必须提供 text");
      return { text: raw.text, ref: { kind: "text", ref: "text", version: "", sha256: sha256(raw.text) } };
    }
    if (kind === "task_result") {
      const task = typeof raw.task_id === "string" ? deps.store.getTask(raw.task_id) : null;
      if (!task || !taskReadable(deps, mainProjectId, task)) throw new Error("任务不存在或不在 main 可读范围");
      if (task.status !== "completed" || task.resultSummary === null) throw new Error("只能引用已完成且已记录结果的任务（不从会话最新回复推断）");
      return { text: task.resultSummary, ref: { kind, ref: `task:${task.id}`, version: task.endedAt ?? "", sha256: sha256(task.resultSummary) } };
    }
    if (kind === "chat_result") {
      if (typeof raw.task_id !== "string") throw new Error("群结果来源必须提供 task_id");
      const accepted = resolveAcceptedChatResult(deps.store, qq, mainProjectId, raw.task_id);
      return { text: accepted.summary, ref: { kind, ref: `chat_result:${accepted.taskId}`, version: accepted.acceptedAt, sha256: sha256(accepted.summary) } };
    }
    if (kind === "artifact") {
      const artifact = typeof raw.artifact_id === "string" ? deps.store.getArtifact(raw.artifact_id) : null;
      const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
      if (!artifact || !project || !mainCanRead(deps, mainProjectId, project, "artifact")) throw new Error("产物不存在或不在 main 可读范围");
      if (artifact.status !== "complete") throw new Error("产物尚未定稿，不能引用");
      const offset = Number(raw.offset ?? 0);
      const length = Number(raw.length ?? NOTIFY_LIMITS.textBytes);
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > NOTIFY_LIMITS.textBytes) {
        throw new Error(`产物片段 offset/length 非法（length ≤ ${NOTIFY_LIMITS.textBytes}）`);
      }
      const buf = deps.artifacts.read(artifact.id, offset, length);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        throw new Error("产物片段不是合法 UTF-8 文本（或截断在多字节字符中间），拒绝引用");
      }
      if (text.includes("\u0000")) throw new Error("产物片段含二进制内容，拒绝引用");
      return { text, ref: { kind, ref: `artifact:${artifact.id}@${offset}+${buf.length}`, version: String(artifact.byteCount), sha256: sha256(text) } };
    }
    if (kind === "app_data") {
      const store = deps.appData();
      if (!store) throw new Error("应用数据能力不可用，不能生成快照");
      const table = typeof raw.table === "string" ? store.getTable(raw.table) : null;
      const rowId = Number(raw.row_id);
      const field = String(raw.field ?? "");
      if (!table || !Number.isSafeInteger(rowId) || !table.fields.some((f) => f.name === field)) throw new Error("应用数据表/行/字段不存在");
      const row = store.getRow(table, rowId);
      if (!row) throw new Error(`行 ${rowId} 不存在`);
      const value = row[field];
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error("字段值为空或不是标量，不能作为正文");
      const text = String(value);
      const versions = store.getVersions();
      return {
        text,
        ref: {
          kind,
          ref: `app_data:${store.getInstanceId()}/${table.name}#${rowId}.${field}`,
          version: `row v${row._version} schema v${versions.schemaVersion}`,
          sha256: sha256(text),
        },
      };
    }
    throw new Error("来源 kind 只能是 text / task_result / artifact / app_data / chat_result");
  };

  return {
    /** 解析为最终正文（多个来源按顺序换行拼接）。 */
    resolve(mainProjectId: string, content: unknown): { text: string; refs: SourceRef[] } {
      if (!Array.isArray(content) || content.length === 0 || content.length > NOTIFY_LIMITS.sources) {
        throw new Error(`content 必须是 1–${NOTIFY_LIMITS.sources} 个来源`);
      }
      const parts = content.map((c) => resolveOne(mainProjectId, (c ?? {}) as Record<string, unknown>));
      return { text: parts.map((p) => p.text).join("\n"), refs: parts.map((p) => p.ref) };
    },
    /** 发送前复核可撤销的资料授权（快照正文不变；授权撤销后不得继续外发）。 */
    verify(mainProjectId: string, refs: SourceRef[]): string | null {
      for (const r of refs) {
        if (r.kind === "chat_result") {
          try {
            const accepted = resolveAcceptedChatResult(deps.store, qq, mainProjectId, r.ref.slice("chat_result:".length));
            if (accepted.acceptedAt !== r.version || sha256(accepted.summary) !== r.sha256) return "群结果接收快照不匹配";
          } catch (err) {
            return (err as Error).message;
          }
        } else if (r.kind === "task_result") {
          const task = deps.store.getTask(r.ref.slice("task:".length));
          if (!task || !taskReadable(deps, mainProjectId, task)) return `来源 ${r.ref} 的资料授权已撤销或任务不可读`;
        } else if (r.kind === "artifact") {
          const id = r.ref.slice("artifact:".length).split("@")[0]!;
          const artifact = deps.store.getArtifact(id);
          const project = artifact ? deps.store.getSession(artifact.sessionId)?.projectId : null;
          if (!project || !mainCanRead(deps, mainProjectId, project, "artifact")) return `来源 ${r.ref} 的资料授权已撤销或产物不可读`;
        }
      }
      return null;
    },
  };
}

export type SourceResolver = ReturnType<typeof createSourceResolver>;

// ---------- 工具 ----------

export interface SchedulerToolsDeps {
  coreStore: Store;
  sched: SchedulerStore;
  scheduler: Scheduler;
  sources: SourceResolver;
  /** 可信宿主通知目标（null = 未配置，拒绝创建外发）。 */
  target(): NotifyTarget | null;
  now(): number;
  taskContext(): HostToolContext | null;
  bindCall?(sdkCallId: string): () => void;
  verifyMain(ctx: HostToolContext): string | null;
  awaitApproval(input: {
    task: Task;
    hostOpId: string;
    toolName: string;
    params: Record<string, unknown>;
    scope: ApprovalScope;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome>;
}

function okText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function validateReason(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new Error("reason 必填（非空）");
  if (bytes(raw) > NOTIFY_LIMITS.reasonBytes) throw new Error(`reason 超过 ${NOTIFY_LIMITS.reasonBytes} 字节`);
  return raw;
}

function checkText(text: string, what: string): void {
  if (!text.trim()) throw new Error(`${what}为空`);
  if ([...text].length > NOTIFY_LIMITS.textChars || bytes(text) > NOTIFY_LIMITS.textBytes) {
    throw new Error(`${what}超过 ${NOTIFY_LIMITS.textChars} 字符或 ${NOTIFY_LIMITS.textBytes} 字节（不截断、不拆分）`);
  }
}

function targetText(t: NotifyTarget | null): string {
  return t ? `${t.channel} 账号 ${t.account} 会话 ${t.chatId}（配置 v${t.configVersion}）` : "未配置可信 owner 通知目标";
}

function scheduleLine(s: Schedule): string {
  return `${s.id} v${s.version} · ${s.status} · ${s.action} · ${describeRule(s.rule)} · 下次 ${s.nextDueAt ?? "无"}`;
}

function opLine(op: NotificationOp): string {
  const extra = [op.waitReason && `等待：${op.waitReason}`, op.errorKind && `错误：${op.errorKind}`, op.platformMessageId && `回执 ${op.platformMessageId}`, op.cancelRequested && "已记录取消意图"]
    .filter(Boolean)
    .join(" · ");
  return `${op.id} · ${op.status} · ${op.sourceKind} · 创建 ${op.createdAt}${extra ? ` · ${extra}` : ""}`;
}

export function createSchedulerTools(deps: SchedulerToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const requireCtx = (): HostToolContext => {
    const ctx = deps.taskContext();
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    const problem = deps.verifyMain(ctx);
    if (problem) throw new Error(`身份校验失败：${problem}`);
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        const ctx = requireCtx();
        if (bytes(JSON.stringify(params ?? {})) > NOTIFY_LIMITS.paramsBytes) throw new Error(`参数超过 ${NOTIFY_LIMITS.paramsBytes} 字节`);
        return await fn(ctx, params);
      } catch (err) {
        if (err instanceof RuleError || err instanceof SchedulerConflictError) throw new Error(err.message);
        throw err;
      } finally {
        unbind();
      }
    };

  /** 拥有者确认 → 获批后重核身份与目标 → 同一事务消费批准并写入。 */
  const approveThenCommit = async <T>(input: {
    ctx: HostToolContext;
    toolName: string;
    params: Record<string, unknown>;
    scope: Extract<ApprovalScope, { kind: "notification" }>;
    commit: (approvalId: string) => T;
  }): Promise<T> => {
    const task = store.getTask(input.ctx.taskId);
    if (!task) throw new Error("宿主任务不存在");
    const approval = await deps.awaitApproval({ task, hostOpId: input.ctx.hostOpId, toolName: input.toolName, params: input.params, scope: input.scope });
    if (approval.decision !== "approved") {
      throw new Error(approval.decision === "rejected" ? "拥有者拒绝该通知外发，未登记" : "审批已失效（任务停止或权限版本变化），未登记");
    }
    requireCtx();
    if (JSON.stringify(deps.target()) !== JSON.stringify(input.scope.target)) throw new Error("通知目标配置在确认期间已变化或停用，原批准失效（未登记）");
    const confirmation = store.listConfirmationsByTask(input.ctx.taskId).find((c) => c.toolOpId === input.ctx.hostOpId && c.status === "approved");
    if (!confirmation) throw new Error("审批记录缺失或已失效，未登记");
    return store.withTx(() => {
      const sourceProblem = deps.sources.verify(input.ctx.projectId, (input.params.source_refs ?? []) as SourceRef[]);
      if (sourceProblem) throw new Error(`通知资料已失效：${sourceProblem}`);
      const ok = store.consumeApproval({
        confirmationId: confirmation.id,
        expectedPermissionVersion: confirmation.permissionVersion,
        activeStatuses: ["running", "awaiting_confirmation"],
      });
      if (!ok) throw new Error("批准已失效（任务结束、权限版本变化或已被消费），未登记");
      store.appendEvent(
        { type: "task.approval_consumed", taskId: input.ctx.taskId, confirmationId: confirmation.id, toolOpId: input.ctx.hostOpId, toolName: input.toolName },
        { taskId: input.ctx.taskId, sessionId: input.ctx.sessionId },
      );
      return input.commit(confirmation.id);
    });
  };

  const ruleSchema = Type.Object({
    kind: Type.Union([Type.Literal("once"), Type.Literal("daily"), Type.Literal("weekly")]),
    time_zone: Type.String({ description: "IANA 时区（如 Asia/Shanghai）" }),
    at: Type.Optional(Type.String({ description: "once：带 Z 或显式偏移的 ISO 时间" })),
    time: Type.Optional(Type.String({ description: "daily/weekly：当地 HH:mm" })),
    weekdays: Type.Optional(Type.Array(Type.Number(), { description: "weekly：ISO 星期 1–7（1=周一）" })),
  });
  const contentSchema = Type.Array(Type.Record(Type.String(), Type.Unknown()), {
    description:
      "正文来源（≤8 个，按序换行拼接，登记前解析为固定文本）：{kind:'text',text} | {kind:'task_result',task_id} | " +
      "{kind:'artifact',artifact_id,offset?,length?} | {kind:'app_data',table,row_id,field} | {kind:'chat_result',task_id}（须先 chat_result_accept）",
  });

  const scheduleCreate = defineTool({
    name: "schedule_create",
    label: "schedule_create",
    description:
      "登记一次性/每日/每周计划。action=wake_main 到期唤醒 main 执行（note 为触发说明，唤醒任务不继承外发授权）；" +
      "action=notify 到期向可信 owner 目标发送已批准的固定正文（需拥有者确认，周期计划持续至取消）。" +
      "同 create_key 同参返回原计划，异参冲突。修改时间/正文/动作请取消后重建。",
    parameters: Type.Object({
      create_key: Type.String({ description: "稳定创建键（main 范围内唯一，重试用同一个）" }),
      action: Type.Union([Type.Literal("wake_main"), Type.Literal("notify")]),
      rule: ruleSchema,
      note: Type.Optional(Type.String({ description: `wake_main：触发说明（≤${NOTIFY_LIMITS.noteBytes} 字节）` })),
      content: Type.Optional(contentSchema),
      reason: Type.String({ description: "登记理由（必填）" }),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const key = String(params.create_key ?? "");
      if (!key.trim() || key.length > NOTIFY_LIMITS.createKeyChars) throw new Error(`create_key 必须是 1–${NOTIFY_LIMITS.createKeyChars} 字符`);
      const reason = validateReason(params.reason);
      const rule: ScheduleRule = parseRule(params.rule);
      const action = params.action === "notify" ? "notify" : params.action === "wake_main" ? "wake_main" : null;
      if (!action) throw new Error("action 只能是 wake_main / notify");
      const digest = sha256(JSON.stringify({ action, rule, note: params.note ?? null, content: params.content ?? null }));
      const createKey = `main:${key}`;
      const existing = deps.sched.findScheduleByCreateKey(createKey);
      if (existing) {
        if (existing.paramsDigest !== digest) throw new Error(`create_key 已绑定参数不同的计划 ${existing.id}（同键异参冲突）`);
        return okText(`计划已存在（重复登记返回原计划）：${scheduleLine(existing)}`);
      }
      if (deps.sched.countActive() >= SCHEDULER_LIMITS.maxActive) throw new Error(`活跃计划已达上限 ${SCHEDULER_LIMITS.maxActive}`);
      const base = {
        createKey,
        paramsDigest: digest,
        createTaskId: ctx.taskId,
        createOpId: ctx.hostOpId,
        rule,
        nextDueAt: firstDue(rule, deps.now()),
        tzData: tzDataVersion(),
        reason,
      };
      if (action === "wake_main") {
        const note = typeof params.note === "string" ? params.note : "";
        if (!note.trim() || bytes(note) > NOTIFY_LIMITS.noteBytes) throw new Error(`wake_main 需要 note（1–${NOTIFY_LIMITS.noteBytes} 字节）`);
        const s = store.withTx(() =>
          deps.sched.insertSchedule({ ...base, action, payload: { text: note, sourceRefs: [] }, target: null, approvalId: null }, "main_tool"),
        );
        return okText(`已登记：${scheduleLine(s)}`);
      }
      const target = deps.target();
      if (!target) throw new Error("未配置可信 owner 通知目标，不能创建外发计划（不猜测接收者）");
      const { text, refs } = deps.sources.resolve(ctx.projectId, params.content);
      checkText(text, "通知正文");
      const approvalParams = { create_key: key, action, rule, text, target, source_refs: refs, reason };
      const s = await approveThenCommit({
        ctx,
        toolName: "schedule_create",
        params: approvalParams,
        scope: {
          kind: "notification",
          mode: "schedule",
          taskId: ctx.taskId,
          toolOpId: ctx.hostOpId,
          target,
          textSha256: sha256(text),
          textChars: [...text].length,
          rule: describeRule(rule),
          duration: rule.kind === "once" ? "single" : "until_canceled",
          sourceRefs: refs.map((r) => r.ref),
        },
        // 首次到期在批准提交时重算：等待确认期间错过的首个时刻不算漏过
        commit: (approvalId) =>
          deps.sched.insertSchedule({ ...base, nextDueAt: firstDue(rule, deps.now()), action, payload: { text, sourceRefs: refs }, target, approvalId }, "main_tool"),
      });
      return okText(`已登记（拥有者已批准）：${scheduleLine(s)}`);
    }),
  } as any);

  const scheduleQuery = defineTool({
    name: "schedule_query",
    label: "schedule_query",
    description: "查看计划：按 schedule_id 看详情（规则、下次时间、批准范围、最近运行）；或按状态分页列出（每页 ≤50）。同时显示可信 owner 通知目标是否已配置。",
    parameters: Type.Object({
      schedule_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("canceled")])),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const head = `通知目标：${targetText(deps.target())}`;
      if (typeof params.schedule_id === "string") {
        const s = deps.sched.getSchedule(params.schedule_id);
        if (!s) throw new Error(`计划不存在：${params.schedule_id}`);
        const problem = deps.sources.verify(ctx.projectId, s.payload.sourceRefs);
        if (problem) throw new Error(`计划资料不可读：${problem}`);
        const runs = deps.sched.listRuns(s.id, 20).map((r) =>
          `  运行 ${r.id} · 原定 ${r.localTime} · 延迟 ${Math.round(r.delayMs / 1000)}s${r.coalescedFrom ? ` · 合并 ${r.coalescedFrom}–${r.coalescedTo}` : ""} · ${r.closedAt ? "已关闭" : "未完成"} · ${r.inboundEventId ? `事件 ${r.inboundEventId}` : `发送 ${r.notificationOpId}`}`,
        );
        return okText([
          head,
          scheduleLine(s),
          `批准：${s.approvalId ?? "无（wake_main 不需要）"} · 目标：${s.target ? targetText(s.target) : "无"} · 时区数据：${s.tzData}`,
          `正文/说明：${s.payload.text}`,
          ...(s.payload.sourceRefs.length ? [`来源：${s.payload.sourceRefs.map((r) => `${r.ref}（${r.version}）`).join(", ")}`] : []),
          ...(s.cancelReason ? [`取消理由：${s.cancelReason}`] : []),
          ...runs,
        ].join("\n"));
      }
      const { items, nextCursor } = deps.sched.listSchedules({ status: params.status, cursor: params.cursor, limit: params.limit });
      return okText([head, ...items.map(scheduleLine), nextCursor ? `next_cursor=${nextCursor}` : "（无更多）"].join("\n"));
    }),
  } as any);

  const scheduleCancel = defineTool({
    name: "schedule_cancel",
    label: "schedule_cancel",
    description: "取消计划（带预期版本，幂等；取消后不复活）：停止未来触发并取消尚未发送的关联通知；已执行的任务与在途发送保留真实结果。",
    parameters: Type.Object({
      schedule_id: Type.String(),
      expected_version: Type.Number(),
      reason: Type.String({ description: "取消理由（必填）" }),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const reason = validateReason(params.reason);
      const s = await deps.scheduler.cancelSchedule({
        scheduleId: String(params.schedule_id),
        expectedVersion: Number(params.expected_version),
        reason,
        source: "main_tool",
        cancelOpId: ctx.hostOpId,
      });
      return okText(`已取消：${scheduleLine(s)}`);
    }),
  } as any);

  const notificationEnqueue = defineTool({
    name: "notification_enqueue",
    label: "notification_enqueue",
    description:
      "向可信 owner 目标排队一次通知（需拥有者确认完整正文与目标）。每个任务只有一个一次通知槽：重复调用返回同一操作，改正文报冲突。" +
      "工具只返回“已排队”与操作 ID；发送结果用 notification_query 查询（结果未知不会自动重发）。",
    parameters: Type.Object({
      content: contentSchema,
      reason: Type.String({ description: "发送理由（必填）" }),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      const reason = validateReason(params.reason);
      const target = deps.target();
      if (!target) throw new Error("未配置可信 owner 通知目标，不能外发（不猜测接收者）");
      const { text, refs } = deps.sources.resolve(ctx.projectId, params.content);
      checkText(text, "通知正文");
      const sourceKey = `task:${ctx.taskId}`;
      const existing = deps.sched.findOpBySource("confirmation", sourceKey);
      if (existing) {
        if (existing.textSha256 !== sha256(text)) throw new Error(`本任务的一次通知槽已登记不同正文（操作 ${existing.id}），不能换键重发`);
        return okText(`已排队（重复调用返回原操作）：${opLine(existing)}`);
      }
      const op = await approveThenCommit({
        ctx,
        toolName: "notification_enqueue",
        params: { text, target, source_refs: refs, reason },
        scope: {
          kind: "notification",
          mode: "once",
          taskId: ctx.taskId,
          toolOpId: ctx.hostOpId,
          target,
          textSha256: sha256(text),
          textChars: [...text].length,
          rule: null,
          duration: "single",
          sourceRefs: refs.map((r) => r.ref),
        },
        commit: () => deps.sched.insertOp({ sourceKind: "confirmation", sourceKey, taskId: ctx.taskId, hostOpId: ctx.hostOpId, target, text, sourceRefs: refs }).op,
      });
      deps.scheduler.kickSender();
      return okText(`已排队：${op.id}（发送结果用 notification_query 查询）`);
    }),
  } as any);

  const notificationQuery = defineTool({
    name: "notification_query",
    label: "notification_query",
    description: "查看发送操作：按 op_id 看详情（目标、来源、状态、错误、平台回执、正文）；或按状态分页列出（每页 ≤50）。effect_unknown 表示结果未知、不会自动重发，需拥有者核实。",
    parameters: Type.Object({
      op_id: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union(["pending", "sending", "sent", "failed", "effect_unknown", "canceled"].map((s) => Type.Literal(s)))),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      if (typeof params.op_id === "string") {
        const op = deps.sched.getOp(params.op_id);
        if (!op) throw new Error(`发送操作不存在：${params.op_id}`);
        const problem = deps.sources.verify(ctx.projectId, op.sourceRefs);
        if (problem) throw new Error(`发送资料不可读：${problem}`);
        return okText([
          opLine(op),
          `目标：${targetText(op.target)} · 来源键 ${op.sourceKind}:${op.sourceKey}`,
          ...(op.errorMessage ? [`说明：${op.errorMessage}`] : []),
          ...(op.lateReceipt ? [`迟到回执：${op.lateReceipt}（未改变状态、未重发）`] : []),
          `正文：${op.text}`,
        ].join("\n"));
      }
      const { items, nextCursor } = deps.sched.listOps({ status: params.status, cursor: params.cursor, limit: params.limit });
      return okText([...items.map(opLine), nextCursor ? `next_cursor=${nextCursor}` : "（无更多）"].join("\n"));
    }),
  } as any);

  const notificationCancel = defineTool({
    name: "notification_cancel",
    label: "notification_cancel",
    description: "取消发送操作：未领取的 pending 直接取消；发送中的只记录取消意图并按真实结果收尾；已终态不变。",
    parameters: Type.Object({ op_id: Type.String(), reason: Type.String({ description: "取消理由（必填）" }) }),
    execute: bindExecute(async (ctx, params: any) => {
      const reason = validateReason(params.reason);
      const op = store.withTx(() => deps.sched.cancelOp(String(params.op_id), reason, ctx.hostOpId));
      if (!op) throw new Error(`发送操作不存在：${params.op_id}`);
      return okText(opLine(op));
    }),
  } as any);

  return [scheduleCreate, scheduleQuery, scheduleCancel, notificationEnqueue, notificationQuery, notificationCancel] as ToolDefinition[];
}
