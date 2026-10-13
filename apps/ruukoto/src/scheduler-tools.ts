/**
 * main 的调度与通知宿主工具（issue 03）：schedule_create / query / cancel，
 * notification_enqueue / query / cancel。仅宿主引导的 main 角色会话装配。
 *
 * - 身份由宿主注入并在执行入口每次重核（任务/会话/项目/main 绑定）；
 * - 目标只来自可信宿主渠道配置；模型不能传入 URL、chat/user ID、凭据或审批 ID；
 * - 计划保存创建时任务模式、资料项目、自足说明与固定最终回报目标；每次独立执行；
 * - 一次通知在 full_access 下免审批，受限模式须确认固定正文与目标；
 *   授权、执行复核与发送操作在同一核心事务提交；
 * - 正文可直接提交文本，或从已完成任务结果、可访问产物的文本片段、应用数据
 *   记录字段解析；登记前解析为最终文本并保存来源版本与摘要，之后业务数据变化
 *   不改变已登记正文；发送前复核可撤销的资料授权。
 */

import { defineTool,type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalGate } from "@ruukoto/agent/approval-gate.ts";
import type { HostToolFamily } from "@ruukoto/agent/host-tool-families.ts";
import type { HostCallBinder,HostToolContext } from "@ruukoto/agent/host-tools.ts";
import { hostCallFor } from "@ruukoto/agent/host-tools.ts";
import { SCHEDULER_LEDGER,SCHEDULER_TOOL_NAMES,schedulerOpCheck } from "@ruukoto/channels/scheduler/ledger.ts";
import { SCHEDULER_LIMITS,type Scheduler } from "@ruukoto/channels/scheduler/runtime.ts";
import { SchedulerConflictError,sha256,type NotificationOp,type Schedule,type SchedulerStore,type SourceRef } from "@ruukoto/channels/scheduler/store.ts";
import { describeRule,firstDue,parseRule,RuleError,tzDataVersion,type ScheduleRule } from "@ruukoto/channels/scheduler/time.ts";
import { NOTIFY_LIMITS,type SourceResolver } from "@ruukoto/channels/source-resolver.ts";
import type { Store } from "@ruukoto/core/store.ts";
import { RuntimeApiError } from "@ruukoto/core/api-error.ts";
import { isTerminalTaskStatus, type ApprovalScope, type NotifyTarget } from "@ruukoto/core/types.ts";
import { Type } from "typebox";

export function createSchedulerFamily(config: Omit<SchedulerToolsDeps, "scheduler" | "taskContext" | "bindCall" | "verifyMain" | "requestApproval"> & { scheduler: Scheduler | null }): HostToolFamily {
  return {
    category: "scheduler",
    names: config.scheduler ? SCHEDULER_TOOL_NAMES : [],
    build: (runtime) => config.scheduler ? createSchedulerTools({
      ...config,
      scheduler: config.scheduler,
      ...runtime.call,
      verifyMain: runtime.identity.verifyMain,
      requestApproval: runtime.approval.request,
    }) : [],
    ledger: { ...SCHEDULER_LEDGER, familyCheck: schedulerOpCheck(config.sched) },
  };
}



const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// ---------- 工具 ----------

export interface SchedulerToolsDeps {
  coreStore: Store;
  sched: SchedulerStore;
  scheduler: Scheduler;
  sources: SourceResolver;
  /** 可信宿主通知目标（null = 未配置，拒绝创建外发）。 */
  target(ctx: HostToolContext): NotifyTarget | null;
  now(): number;
  taskContext(): HostToolContext | null;
  bindCall?: HostCallBinder;
  verifyMain(ctx: HostToolContext): string | null;
  /** 审批闸门（窄回调；不向模型暴露控制面）。 */
  requestApproval: ApprovalGate["request"];
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
  return `${s.id} v${s.version} · ${s.status} · ${s.accessMode} · ${describeRule(s.rule)} · 下次 ${s.nextDueAt ?? "无"}`;
}

function opLine(op: NotificationOp): string {
  const extra = [op.waitReason && `等待：${op.waitReason}`, op.errorKind && `错误：${op.errorKind}`, op.platformMessageId && `回执 ${op.platformMessageId}`, op.cancelRequested && "已记录取消意图"]
    .filter(Boolean)
    .join(" · ");
  return `${op.id} · ${op.status} · ${op.sourceKind} · 创建 ${op.createdAt}${extra ? ` · ${extra}` : ""}`;
}

export function createSchedulerTools(deps: SchedulerToolsDeps): ToolDefinition[] {
  const store = deps.coreStore;
  const requireCtx = (ctx: HostToolContext | null): HostToolContext => {
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    const problem = deps.verifyMain(ctx);
    if (problem) throw new Error(`身份校验失败：${problem}`);
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(fn: (ctx: HostToolContext, params: P, signal?: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }> }>) =>
    async (sdkCallId: string, params: P, signal?: AbortSignal) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        const ctx = requireCtx(call.context);
        if (bytes(JSON.stringify(params ?? {})) > NOTIFY_LIMITS.paramsBytes) throw new Error(`参数超过 ${NOTIFY_LIMITS.paramsBytes} 字节`);
        return await fn(ctx, params, signal);
      } catch (err) {
        if (err instanceof RuleError || err instanceof SchedulerConflictError) throw new Error(err.message);
        throw err;
      } finally {
        call.release();
      }
    };

  /** 授权与通知登记同事务：完全访问免审批，受限模式消费固定目标与正文的批准。 */
  const approveThenCommit = async <T>(input: {
    ctx: HostToolContext;
    toolName: string;
    params: Record<string, unknown>;
    scope: Extract<ApprovalScope, { kind: "notification" }>;
    signal?: AbortSignal;
    commit: (approvalId: string | null) => T;
  }): Promise<T> => {
    const task = store.getTask(input.ctx.taskId);
    if (!task) throw new Error("宿主任务不存在");
    const approval = await deps.requestApproval({
      task,
      hostOpId: input.ctx.hostOpId,
      toolName: input.toolName,
      params: input.params,
      scope: input.scope,
      signal: input.signal,
      // 身份按调用开始时捕获的上下文核对：同批并行的宿主工具会改写共享上下文
      recheck: () => {
        const problem = deps.verifyMain(input.ctx);
        if (problem) return `身份校验失败：${problem}`;
        if (JSON.stringify(deps.target(input.ctx)) !== JSON.stringify(input.scope.target)) return "通知目标配置在执行前已变化或停用，本次授权失效（未登记）";
        const sourceProblem = deps.sources.verify(input.ctx.projectId, (input.params.source_refs ?? []) as SourceRef[], input.ctx.taskId);
        return sourceProblem ? `通知资料已失效：${sourceProblem}` : null;
      },
      commit: input.commit,
    });
    if (!approval.approved) throw new Error(approval.text);
    return approval.value;
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
      "登记一次性/每日/每周通用任务。每次到期在独立上下文按保存的任务说明执行，使用创建时模式与明确资料，能使用个人助手工具并委派。" +
      "整项运行完成后向创建时可信 owner 目标回报一次最终结果；无目标时仍可创建，结果留在运行记录。" +
      "同 create_key 同参返回原计划，异参冲突。时间或说明修改需取消后重建；不支持新闻或定时固定通知动作。",
    parameters: Type.Object({
      create_key: Type.String({ description: "稳定创建键（main 范围内唯一，重试用同一个）" }),
      rule: ruleSchema,
      instruction: Type.String({ description: `自足任务说明（≤${NOTIFY_LIMITS.noteBytes} 字节，不自动带入主聊天或前次运行）` }),
      content: Type.Optional(contentSchema),
      reason: Type.String({ description: "登记理由（必填）" }),
    }, { additionalProperties: false }),
    execute: bindExecute(async (ctx, params: Record<string, unknown>, signal) => {
      if (Object.keys(params).some((key) => !["create_key", "rule", "instruction", "content", "reason"].includes(key))) {
        throw new RuntimeApiError("invalid_params", "调度计划只接受时间规则、任务说明与明确资料，不支持旧动作参数");
      }
      const key = String(params.create_key ?? "");
      if (!key.trim() || key.length > NOTIFY_LIMITS.createKeyChars) throw new RuntimeApiError("invalid_params", `create_key 必须是 1–${NOTIFY_LIMITS.createKeyChars} 字符`);
      const reason = validateReason(params.reason);
      const rule = parseRule(params.rule);
      if (typeof params.instruction !== "string" || !params.instruction.trim() || bytes(params.instruction) > NOTIFY_LIMITS.noteBytes) {
        throw new RuntimeApiError("invalid_params", `instruction 必须非空且不超过 ${NOTIFY_LIMITS.noteBytes} 字节`);
      }
      const task = store.getTask(ctx.taskId);
      if (!task) throw new RuntimeApiError("task_ending", "宿主任务不存在，未登记计划");
      const { text, refs } = params.content === undefined ? { text: "", refs: [] } : deps.sources.resolve(ctx.projectId, params.content, ctx.taskId);
      const instruction = params.instruction + (text ? `\n[明确资料]\n${text}` : "");
      if (bytes(instruction) > NOTIFY_LIMITS.paramsBytes) throw new RuntimeApiError("invalid_params", "任务说明与明确资料超过大小上限");
      const target = deps.target(ctx);
      const digest = sha256(JSON.stringify({ rule, instruction, sourceRefs: refs, projectId: ctx.projectId, accessMode: task.accessMode, target }));
      const createKey = `main:${key}`;
      // Note: 见 .agents/notes/implemented/feature/2026-10-12-generic-scheduled-tasks.md
      const schedule = store.withTx(() => {
        const fresh = store.getTask(task.id);
        const identity = deps.verifyMain(ctx);
        if (!fresh || fresh.status !== "running" || fresh.cancelRequested || signal?.aborted || fresh.permissionVersion !== task.permissionVersion || identity) {
          throw new RuntimeApiError("task_ending", "任务已停止、身份或权限已变化，未登记计划");
        }
        if (JSON.stringify(deps.target(ctx)) !== JSON.stringify(target)) throw new RuntimeApiError("entry_changed", "回报目标已变化，未登记计划");
        const sourceProblem = deps.sources.verify(ctx.projectId, refs, ctx.taskId);
        if (sourceProblem) throw new RuntimeApiError("source_revoked", `计划资料已失效：${sourceProblem}`);
        const existing = deps.sched.findScheduleByCreateKey(createKey);
        if (existing) {
          if (existing.paramsDigest !== digest) throw new SchedulerConflictError(`create_key 已绑定参数不同的计划 ${existing.id}（同键异参冲突）`);
          return { value: existing, created: false };
        }
        if (deps.sched.countActive() >= SCHEDULER_LIMITS.maxActive) throw new RuntimeApiError("limit_exceeded", `活跃计划已达上限 ${SCHEDULER_LIMITS.maxActive}`);
        const value = deps.sched.insertSchedule({
          createKey, paramsDigest: digest, createTaskId: task.id, createOpId: ctx.hostOpId,
          projectId: ctx.projectId, createPermissionVersion: task.permissionVersion, accessMode: task.accessMode,
          rule, instruction, sourceRefs: refs, target, nextDueAt: firstDue(rule, deps.now()), tzData: tzDataVersion(), reason,
        }, "main_tool");
        return { value, created: true };
      });
      return okText(`${schedule.created ? "已登记" : "计划已存在（重复登记返回原计划）"}：${scheduleLine(schedule.value)}`);
    }),
  } as any);

  const scheduleQuery = defineTool({
    name: "schedule_query",
    label: "schedule_query",
    description: "查看通用计划与独立运行：详情含创建模式、固定回报目标、自足任务说明、执行会话、整项结果与发送状态；列表按状态分页，每页最多50项。",
    parameters: Type.Object({
      schedule_id: Type.Optional(Type.String()),
      run_id: Type.Optional(Type.String({ description: "配合 schedule_id 查看指定独立运行" })),
      status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("completed"), Type.Literal("canceled")])),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: bindExecute(async (ctx, params: any) => {
      if (typeof params.schedule_id !== "string") {
        const { items, nextCursor } = deps.sched.listSchedules({ status: params.status, cursor: params.cursor, limit: params.limit });
        return okText([...items.map(scheduleLine), nextCursor ? `next_cursor=${nextCursor}` : "（无更多）"].join("\n"));
      }
      const schedule = deps.sched.getSchedule(params.schedule_id);
      if (!schedule) throw new RuntimeApiError("not_found", "调度计划不存在");
      const sourceProblem = deps.sources.verify(ctx.projectId, schedule.sourceRefs, ctx.taskId);
      if (sourceProblem) throw new RuntimeApiError("source_revoked", `计划资料不可读：${sourceProblem}`);
      const selected = typeof params.run_id === "string" ? deps.sched.getRun(params.run_id) : null;
      if (params.run_id && (!selected || selected.scheduleId !== schedule.id)) throw new RuntimeApiError("not_found", "调度运行不属于该计划");
      const runs = selected ? [selected] : deps.sched.listRuns(schedule.id, 10);
      const heldTaskIds = new Set(store.listAllOccupancy().map((held) => held.taskId));
      return okText([
        scheduleLine(schedule),
        `授权来源：任务 ${schedule.createTaskId ?? "导入记录"} 权限 v${schedule.createPermissionVersion} · 资料项目 ${schedule.projectId}`,
        `最终回报：${targetText(schedule.target)} · 时区数据 ${schedule.tzData}`,
        `任务说明：${schedule.instruction}`,
        ...runs.map((run) => {
          const tasks = store.listScheduledRunTasks(run.id);
          const unverified = tasks.filter((task) => isTerminalTaskStatus(task.status) && heldTaskIds.has(task.id));
          return `${run.id} · ${run.localTime} · ${run.resultStatus ?? "未完成"} · 会话 ${run.sessionId ?? "未派发"}` +
            (run.notificationOpId ? ` · 回报 ${deps.sched.getOp(run.notificationOpId)?.status ?? "不可核实"}` : " · 未登记回报") +
            (unverified.length ? `\n停止未核实，目录占用保留：${unverified.slice(0, 20).map((task) => task.id).join("、")}` : "") +
            (tasks.length ? `\n任务：${tasks.slice(0, 20).map((task) => `${task.id} ${task.status}`).join("；")}${tasks.length > 20 ? "；其余见任务记录" : ""}` : "") +
            (run.resultText ? `\n${run.resultText}` : "");
        }),
      ].join("\n"));
    }),
  } as any);

  const scheduleCancel = defineTool({
    name: "schedule_cancel",
    label: "schedule_cancel",
    description: "取消计划（带预期版本，幂等；取消后不复活）：停止未来触发并停止当前整项运行、派生工作与等待审批；未发消息取消，已有成果、在途效果与未核实占用保留。",
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
      "向可信 owner 目标排队一次通知（完全访问免审批，受限模式需拥有者确认完整正文与目标）。每个任务只有一个一次通知槽：重复调用返回同一操作，改正文报冲突。" +
      "工具只返回“已排队”与操作 ID；发送结果用 notification_query 查询（结果未知不会自动重发）。",
    parameters: Type.Object({
      content: contentSchema,
      reason: Type.String({ description: "发送理由（必填）" }),
    }),
    execute: bindExecute(async (ctx, params: any, signal) => {
      const reason = validateReason(params.reason);
      const target = deps.target(ctx);
      if (!target) throw new Error("未配置可信 owner 通知目标，不能外发（不猜测接收者）");
      const { text, refs } = deps.sources.resolve(ctx.projectId, params.content, ctx.taskId);
      checkText(text, "通知正文");
      const sourceKey = `task:${ctx.taskId}`;
      const existing = deps.sched.findOpBySource("tool", sourceKey);
      if (existing) {
        if (existing.textSha256 !== sha256(text)) throw new Error(`本任务的一次通知槽已登记不同正文（操作 ${existing.id}），不能换键重发`);
        return okText(`已排队（重复调用返回原操作）：${opLine(existing)}`);
      }
      const op = await approveThenCommit({
        signal,
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
          sourceRefs: refs.map((r) => r.ref),
        },
        commit: () => deps.sched.insertOp({ sourceKind: "tool", sourceKey, taskId: ctx.taskId, hostOpId: ctx.hostOpId, target, text, sourceRefs: refs }).op,
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
        const problem = deps.sources.verify(ctx.projectId, op.sourceRefs, ctx.taskId);
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
