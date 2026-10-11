/**
 * IM 审批生命周期（agent-direction issue 08）：绑定拥有者在 QQ 私聊 / Telegram
 * 私聊中以整条文本命令查询、批准或拒绝已有审批请求。issue 10 增加长期操作
 * 授权命令：/approve-standing（保存限定授权并批准本次，范围完全来自原审批
 * 记录）、/service-grants、/service-grant、/revoke-service-grant（创建与撤销
 * 同样只在核实身份后于同步事务内落盘；模型、子任务消息与自然语言不能创建
 * 或扩大授权）。
 *
 * 纪律：
 * - 只解析适配器提交的原始发送文本（平台正文模板/引用摘录之前的 commandText）；
 *   自然语言、引用中的命令、转发内容、模型输出与群消息不会被解释为批准；
 * - 控制消息以 event_kind=im_approval 的入站事件持久化（(source, external_id)
 *   幂等去重），在同一事务内直接到 done/failed：不建任务、不调用模型、不进入
 *   普通派发与恢复重放；审批响应不排在等待审批的普通任务后面；
 * - 身份逐项核实：平台、actor（owner）与收件时钉版的目标及配置版本；决定、
 *   审计事件、控制事件终态与回执在同一事务提交，中途写失败全部回滚；
 * - 回执经公共 outbox（sourceKind=inbound_event，键=控制事件 id），目标为命令
 *   收件时钉版的目标；限流只按原操作延后，结果未知不换键重发；同平台消息重投
 *   读取原回执不重复执行，同键异命令拒绝；
 * - 批准只选择原请求与原权限版本，不开放新参数或修改范围；平台身份不会变成
 *   任意控制面访问权。
 */

import type { Store } from "@ruukoto/core/store.ts";
import type { ApprovalScope, ConfirmationRequest, InboundEvent, NotifyTarget, StandingPermission, Task } from "@ruukoto/core/types.ts";
import { sameTarget } from "@ruukoto/core/notify-target.ts";
import { sliceTextByBytes } from "@ruukoto/core/history.ts";
import type { SchedulerStore } from "./scheduler/store.ts";
import type { ImEntry } from "./im-entries.ts";

/** 每页列出的审批/授权条数（有界分页）。 */
const LIST_PAGE_SIZE = 5;
/** 授权详情每页展示的使用记录条数。 */
const USAGE_PAGE_SIZE = 5;
/** 委派链追溯深度上限（断链/循环一律拒绝）。 */
const CHAIN_WALK_LIMIT = 16;
/** 分页参数上限（游标/偏移；超界按格式错误处理）。 */
const PAGE_ARG_MAX = 1_000_000;

type ImApprovalSource = {
  source: string;
  actor: string | null;
  replyTarget: NotifyTarget;
  inboundEvent: InboundEvent | null;
};

export type ImApprovalCommand =
  | { kind: "list"; page: number }
  | { kind: "detail"; confirmationId: string; offset: number }
  | { kind: "decide"; decision: "approved" | "rejected"; confirmationId: string; permissionVersion: number }
  /** 保存限定长期授权并批准本次（agent-direction issue 10）：只接受服务 restart 审批。 */
  | { kind: "approve-standing"; confirmationId: string; permissionVersion: number }
  | { kind: "grants"; page: number }
  | { kind: "grant-detail"; permissionId: string; offset: number }
  | { kind: "revoke-grant"; permissionId: string; expectedVersion: number }
  | { kind: "usage" };

const VERB = "(approve-standing|revoke-service-grant|service-grants|service-grant|approvals|approval|approve|reject)";

/**
 * 整条文本命令解析：只认完整匹配；命令动词已出现但参数不合法 → usage（宿主
 * 返回用法，不交给模型）；其余（自然语言、未知动词）返回 null 走普通入站。
 */
export function parseImApprovalCommand(text: string): ImApprovalCommand | null {
  const trimmed = text.trim();
  const exact = new RegExp(`^\\/${VERB}(?:\\s+(\\S+(?:\\s+\\S+)?))?$`).exec(trimmed);
  if (!exact) {
    return new RegExp(`^\\/${VERB}(?:\\s|$)`).test(trimmed) ? { kind: "usage" } : null;
  }
  const verb = exact[1]!;
  const args = exact[2] === undefined ? [] : exact[2].split(/\s+/);
  const boundedInt = (raw: string): number | null => {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n <= PAGE_ARG_MAX ? n : null;
  };
  if (verb === "approvals") {
    if (args.length === 0) return { kind: "list", page: 0 };
    if (args.length === 1) {
      const page = boundedInt(args[0]!);
      if (page !== null) return { kind: "list", page };
    }
    return { kind: "usage" };
  }
  if (verb === "approval") {
    if (args.length === 1) return { kind: "detail", confirmationId: args[0]!, offset: 0 };
    if (args.length === 2) {
      const offset = boundedInt(args[1]!);
      if (offset !== null) return { kind: "detail", confirmationId: args[0]!, offset };
    }
    return { kind: "usage" };
  }
  if (verb === "service-grants") {
    if (args.length === 0) return { kind: "grants", page: 0 };
    if (args.length === 1) {
      const page = boundedInt(args[0]!);
      if (page !== null) return { kind: "grants", page };
    }
    return { kind: "usage" };
  }
  if (verb === "service-grant") {
    if (args.length === 1) return { kind: "grant-detail", permissionId: args[0]!, offset: 0 };
    if (args.length === 2) {
      const offset = boundedInt(args[1]!);
      if (offset !== null) return { kind: "grant-detail", permissionId: args[0]!, offset };
    }
    return { kind: "usage" };
  }
  if (verb === "revoke-service-grant") {
    if (args.length === 2) {
      const version = boundedInt(args[1]!);
      if (version !== null && version >= 1) return { kind: "revoke-grant", permissionId: args[0]!, expectedVersion: version };
    }
    return { kind: "usage" };
  }
  // approve / approve-standing / reject：完整审批 ID + 正整数权限版本，不接受部分 ID 或新参数
  if (args.length === 2 && (verb === "approve" || verb === "reject" || verb === "approve-standing")) {
    const version = boundedInt(args[1]!);
    if (version !== null && version >= 1) {
      if (verb === "approve-standing") return { kind: "approve-standing", confirmationId: args[0]!, permissionVersion: version };
      return { kind: "decide", decision: verb === "approve" ? "approved" : "rejected", confirmationId: args[0]!, permissionVersion: version };
    }
  }
  return { kind: "usage" };
}

export interface ImControlInput {
  source: string;
  externalId: string;
  actor: string | null;
  /** 命令收件时由适配器按捕获配置钉版的目标（含配置版本）。 */
  replyTarget: NotifyTarget | null;
  /** 原始发送文本（未加模板/引用摘录）。 */
  commandText: string;
}

export interface ImApprovalsDeps {
  store: Store;
  sched: SchedulerStore;
  /**
   * 按来源取拥有者 IM 入口（架构工单 10）：当前钉版目标（null = 停用/凭据不可用）、
   * 期望的 actor（null = 未绑定，任何命令都不接纳）与单条回执字符上限。
   */
  entry(source: string): Pick<ImEntry, "target" | "expectedActor" | "replyCapChars" | "gatePrivate"> | null;
  /**
   * 决定执行：经活动 Driver 的审批闸门把决定、审计事件与 txExtra 在同一事务
   * 提交后唤醒等待者；返回 false = 无活动执行或已被其他入口处理。txExtra 抛错
   * 则决定整笔回滚并向上抛出。txExtra 返回的长期授权关联写进批准与决定事件
   * （issue 10，/approve-standing）。
   */
  applyDecision(
    confirmation: ConfirmationRequest,
    decision: "approved" | "rejected",
    txExtra: () => void | { standingPermission?: { id: string; version: number } },
  ): boolean;
  /** 已死入口的审批事务提交后，仅解除这些审批的 Driver 等待。 */
  supersedeApprovals(sessionId: string, ids: ReadonlySet<string>): void;
  /** 服务管理是否已配置；不在候选阶段重新读取部署策略。 */
  serviceAvailable(): boolean;
  /**
   * 服务部署策略的当前修订（同步重读核对；agent-direction issue 10）：
   * null = 本机无服务管理能力或策略不可核对（不得保存授权）。
   */
  servicePolicyRevision?(): string | null;
  /** 提交后唤醒发送器（尽早送达；不改变 outbox 纪律）。 */
  kickSender(): void;
}

export interface ImCommandOutcome {
  control: true;
  eventId: string | null;
  outcome: string;
}

export class ImApprovals {
  constructor(private readonly deps: ImApprovalsDeps) {}

  /**
   * 审批创建通知（在审批登记事务内调用）：IM 来源的审批同事务登记初始 IM
   * 通知（键 im-approval:<confirmationId>，避开 task:<taskId> 的一次通知槽；
   * 目标为原委托收件时钉版的目标）。非 IM 来源不通知；通知暂时发送失败不使
   * 操作获批，审批的有效性继续由原请求与宿主核实。
   */
  notifyCreated(confirmation: ConfirmationRequest, task: Task): void {
    const event = this.imSource(task.id);
    if (!event) return;
    const capChars = (text: string, cap: number): string => {
      const chars = [...text];
      return chars.length <= cap ? text : `${chars.slice(0, cap - 1).join("")}…`;
    };
    // 服务管理（issue 09）：准确目标、提权身份、动作影响与请求时状态必须完整
    // 可见（JSON 截断不能藏住它们）；其余范围沿用 JSON 摘要 + 详情命令
    const scopeBrief = (c: ConfirmationRequest): string => {
      if (c.scope.kind === "service_operation") {
        const before = (c.params.state_before ?? null) as { activeState?: string; subState?: string } | null;
        const stateText = before?.activeState ? `；请求时状态 ${before.activeState}/${before.subState ?? "?"}` : "";
        return `服务管理 ${c.scope.action} ${c.scope.unit}（root 提权，经后台固定 helper；原本不活动会被启动；中断后效果可能无法确认且不自动重发${stateText}；策略/单元修订 ${c.scope.policyRevision.slice(0, 8)}…/${c.scope.unitRevision.slice(0, 8)}…）`;
      }
      return capChars(JSON.stringify(c.scope), 300);
    };
    // 同目标历史效果未知操作（issue 10）：批准前的核实参照——长期授权不代替核实
    let unknownOpsNote: string | null = null;
    if (confirmation.scope.kind === "service_operation") {
      const scope = confirmation.scope;
      const unknown = this.deps.store.listEffectUnknownToolOps("service_manage", 5).filter((op) => op.params["unit"] === scope.unit && op.params["machine_id"] === scope.machineId);
      if (unknown.length) {
        unknownOpsNote = `注意：该目标存在 ${unknown.length} 项结果未知的历史操作（${unknown.map((o) => o.id).join(", ")}）；长期授权前请先核实其实际效果，授权不代替核实。`;
      }
    }
    const text = [
      `【需要审批】${confirmation.toolName}`,
      `审批 ID：${confirmation.id}`,
      `权限版本：v${confirmation.permissionVersion}`,
      `任务：${confirmation.taskId}`,
      `范围：${scopeBrief(confirmation)}`,
      `参数摘要（数据展示，完整见详情）：${capChars(JSON.stringify(confirmation.params), 300)}`,
      `批准（仅本次）：/approve ${confirmation.id} ${confirmation.permissionVersion}`,
      `拒绝：/reject ${confirmation.id} ${confirmation.permissionVersion}`,
      ...(confirmation.scope.kind === "service_operation" && event.inboundEvent !== null
        ? [
            `长期批准（保存本机对该服务的 restart 授权并批准本次；以 root 经后台固定 helper 提权执行；之后独立任务命中相同范围与修订自动放行，持续至撤销或修订/绑定变化；批准后可用 /service-grants 查看、/revoke-service-grant <授权ID> <版本> 撤销）：/approve-standing ${confirmation.id} ${confirmation.permissionVersion}`,
          ]
        : []),
      `详情：/approval ${confirmation.id}`,
      ...(unknownOpsNote ? [unknownOpsNote] : []),
    ].join("\n");
    this.deps.sched.insertOp({
      sourceKind: "confirmation",
      sourceKey: `im-approval:${confirmation.id}`,
      taskId: confirmation.taskId,
      hostOpId: null,
      target: event.replyTarget!,
      text,
      sourceRefs: [],
    });
    // 提交成功后尽早送达（微任务只在同步创建回调全部完成后才执行）
    queueMicrotask(() => this.deps.kickSender());
  }

  /**
   * 消费前 IM 固定身份复核（在消费事务内调用）：批准已接受、尚未消费期间的
   * 重新绑定/停用/凭据变化在此拦截；非 IM 来源无此约束；已消费不受影响。
   */
  consumeRecheck(confirmation: ConfirmationRequest, task: Task): string | null {
    const event = this.imSource(task.id);
    if (!event) return null;
    const current = this.deps.entry(event.source)?.target() ?? null;
    if (!current || !sameTarget(current, event.replyTarget)) {
      return `批准已失效（IM 入口停用或绑定/配置版本已变化），${confirmation.toolName} 未执行`;
    }
    return null;
  }

  /**
   * IM 固定身份失效（issue 08）：未消费的待决与已批准请求失效并解除等待
   * （不能永久挂起）；仅影响原平台来源，不波及另一平台在共享 main 会话中的
   * 工作；暂时离线（wait）不作废；已消费的批准不动（消费即执行开始）。
   * 同一事务内，该入口稳定身份已死的长期授权一并明确失效（递增版本，保留记录；
   * issue 10），另一平台原本独立的授权不受影响。
   */
  invalidate(source: string): void {
    const released = new Map<string, Set<string>>();
    this.deps.store.withTx(() => {
      for (const status of ["pending", "approved"] as const) {
        for (const c of this.deps.store.listConfirmationsByStatus(status)) {
          if (c.consumedAt !== null) continue;
          const event = this.imSource(c.taskId);
          if (!event || event.source !== source) continue;
          const entry = this.deps.entry(event.source);
          const current = entry?.target();
          const gate = event.inboundEvent ? entry?.gatePrivate(event.inboundEvent) ?? "run"
            : current && sameTarget(current, event.replyTarget) ? "run" : { drop: "定时绑定已失效" };
          if (gate === "run" || gate === "wait") continue;
          this.deps.store.invalidateConfirmation(c.id);
          const ids = released.get(c.sessionId) ?? new Set<string>();
          ids.add(c.id);
          released.set(c.sessionId, ids);
        }
      }
      // 长期授权（issue 10）：入口代次/拥有者绑定已死的明确失效；暂时离线
      // （target() 仍按配置给出，gate 为 wait）不算绑定变化，正常重启也保留。
      const currentTarget = this.deps.entry(source)?.target() ?? null;
      const expectedActor = this.deps.entry(source)?.expectedActor() ?? null;
      for (const sp of this.deps.store.listActiveStandingPermissions()) {
        if (sp.channel !== source) continue;
        const alive = currentTarget !== null && sameTarget(currentTarget, sp.pinnedTarget) && sp.actor === expectedActor;
        if (!alive) this.deps.store.invalidateStandingPermission(sp.id, "entry_changed");
      }
    });
    // 解除活动 Driver 的审批等待（已知未执行记录由闸门照常补记），不动其他审批
    for (const [sessionId, ids] of released) this.deps.supersedeApprovals(sessionId, ids);
  }

  /**
   * 长期授权候选（agent-direction issue 10）：宿主按当前 main、任务来源入口身份、
   * 本机/单元/固定动作与两项修订逐项核实；观察到失配的旧授权在同一事务内明确
   * 失效（revision_changed/entry_changed）。候选 ≠ 执行依据：授权版本/未撤销与
   * 完整范围在消费事务内重新核实（ApprovalGate.requestStanding）。无 IM 来源
   * （TUI 提交、调度、GitHub、子任务消息等）恒为 null，不能因共用 main 而继承。
   * 在 service_manage 的请求路径调用（helper 已给出本次真实修订）。
   */
  standingCandidate(task: Task, scope: Extract<ApprovalScope, { kind: "service_operation" }>): { id: string; version: number } | null {
    if (!this.deps.serviceAvailable()) return null;
    const event = this.imSource(task.id);
    if (!event?.inboundEvent || !event.actor) return null;
    return this.deps.store.withTx(() => {
      const sp = this.deps.store.findStandingCandidate({
        sessionId: task.sessionId,
        channel: event.source,
        account: event.replyTarget!.account,
        chatId: event.replyTarget!.chatId,
        actor: event.actor!,
        machineId: scope.machineId,
        unit: scope.unit,
        action: "restart",
      });
      if (!sp) return null;
      // 入口代次：钉版目标与当前完全一致（含配置版本），actor 仍是当前绑定拥有者；
      // 引擎内的钉版代次差异由消费事务的固定身份复核拦截（不在此失效）
      const current = this.deps.entry(event.source)?.target() ?? null;
      const alive = current !== null && sameTarget(current, sp.pinnedTarget) && sp.actor === (this.deps.entry(event.source)?.expectedActor() ?? null);
      if (!alive) {
        this.deps.store.invalidateStandingPermission(sp.id, "entry_changed");
        return null;
      }
      // 策略/单元修订两项都要求原目标代次完全一致；失配的旧授权明确失效
      if (sp.policyRevision !== scope.policyRevision || sp.unitRevision !== scope.unitRevision) {
        this.deps.store.invalidateStandingPermission(sp.id, "revision_changed");
        return null;
      }
      return { id: sp.id, version: sp.version };
    });
  }

  /**
   * 识别并处理审批命令；非命令返回 null（调用方走普通入站登记/派发）。
   * 命令处理不建任务、不调用模型，直接在同步事务内完成。
   */
  async handleCommand(input: ImControlInput): Promise<ImCommandOutcome | null> {
    const command = parseImApprovalCommand(input.commandText);
    if (!command) return null;
    const canonical = input.commandText.trim();
    // 同平台消息重投：先按幂等键读取原记录；同键异命令/异身份拒绝，不重复执行
    const existing = this.deps.store.findInboundEvent(input.source, input.externalId);
    if (existing) return this.handleRedelivery(existing, input, canonical);

    // 身份核实：平台目标与 actor 逐项核对（当前绑定 vs 收件钉版）
    const entry = this.deps.entry(input.source);
    const current = entry?.target() ?? null;
    const expectedActor = entry?.expectedActor() ?? null;
    if (!input.replyTarget) {
      // 无钉版目标（凭据暂不可用等异常）：不可执行也无可靠回执渠道，只留控制记录
      return this.persistNoReceipt(input, canonical, command, "identity_failed");
    }
    if (!current || !input.actor || input.actor !== expectedActor || !sameTarget(current, input.replyTarget)) {
      return this.persist(input, canonical, command, "done", null, `当前入口已停用或绑定已变化：该命令针对的固定身份已失效，未执行。`, "identity_failed");
    }

    switch (command.kind) {
      case "usage":
        return this.persist(input, canonical, command, "done", null, this.usageText(), "usage");
      case "list":
        return this.handleList(input, canonical, command);
      case "detail":
        return this.handleDetail(input, canonical, command);
      case "decide":
        return this.handleDecide(input, canonical, command);
      case "approve-standing":
        return this.handleApproveStanding(input, canonical, command);
      case "grants":
        return this.handleGrants(input, canonical, command);
      case "grant-detail":
        return this.handleGrantDetail(input, canonical, command);
      case "revoke-grant":
        return this.handleRevokeGrant(input, canonical, command);
    }
  }

  /** 重投：类别/actor/原目标/规范命令一致 → 读取原回执（不重复执行、不换键重发）。 */
  private handleRedelivery(existing: InboundEvent, input: ImControlInput, canonical: string): ImCommandOutcome {
    const samePinned = (a: NotifyTarget | null, b: NotifyTarget | null): boolean =>
      a === null || b === null ? a === b : sameTarget(a, b);
    const consistent =
      existing.eventKind === "im_approval" &&
      existing.body === canonical &&
      existing.actor === input.actor &&
      samePinned(existing.replyTarget, input.replyTarget);
    if (!consistent) {
      this.deps.store.withTx(() =>
        this.deps.store.appendEvent(
          { type: "im_approval.redelivery_rejected", eventId: existing.id, source: input.source, externalId: input.externalId, reason: "同键异命令或身份不一致" },
          {},
        ),
      );
      return { control: true, eventId: existing.id, outcome: "redelivery_rejected" };
    }
    // 原回执只读：待发送的仍由 outbox 按原键送达；已终态的不重复发送
    const op = this.deps.sched.findOpBySource("inbound_event", existing.id);
    return { control: true, eventId: existing.id, outcome: op ? "redelivered_receipt_kept" : "redelivered_no_receipt" };
  }

  // ---------- 命令处理 ----------

  private handleList(input: ImControlInput, canonical: string, command: { kind: "list"; page: number }): ImCommandOutcome {
    const pending = this.deps.store.listConfirmationsByStatus("pending").filter((c) => this.eligible(c, input));
    const total = pending.length;
    const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const lines: string[] = [];
    if (total === 0) {
      lines.push("没有待处理的审批。");
    } else if (command.page >= pages) {
      lines.push(`待处理审批共 ${total} 项（第 ${command.page}/${pages - 1} 页为空）。`);
    } else {
      lines.push(`待处理审批 ${total} 项（第 ${command.page}/${pages - 1} 页）：`);
      pending.slice(command.page * LIST_PAGE_SIZE, command.page * LIST_PAGE_SIZE + LIST_PAGE_SIZE).forEach((c, i) => {
        lines.push(`${command.page * LIST_PAGE_SIZE + i + 1}. ${c.id}`);
        lines.push(`   ${c.toolName}｜权限版本 v${c.permissionVersion}｜${this.briefParams(c, 80)}`);
      });
    }
    lines.push("批准：/approve <审批ID> <权限版本>｜拒绝：/reject <审批ID> <权限版本>｜详情：/approval <审批ID>");
    if (total > 0 && command.page < pages - 1) lines.push(`下一页：/approvals ${command.page + 1}`);
    return this.persist(input, canonical, { kind: "list" }, "done", null, lines.join("\n"), "listed");
  }

  private handleDetail(input: ImControlInput, canonical: string, command: { kind: "detail"; confirmationId: string; offset: number }): ImCommandOutcome {
    const c = this.deps.store.getConfirmation(command.confirmationId);
    if (!c || !this.eligible(c, input)) {
      return this.persist(input, canonical, { kind: "detail" }, "done", c?.taskId ?? null,
        `审批 ${command.confirmationId} 不存在、已失效或不属于本入口；未经核实身份不提供详情。`, "not_found");
    }
    const text = this.detailText(input.source, c, command.offset);
    return this.persist(input, canonical, { kind: "detail" }, "done", c.taskId, text, "detailed");
  }

  private handleDecide(input: ImControlInput, canonical: string, command: Extract<ImApprovalCommand, { kind: "decide" }>): ImCommandOutcome {
    const receipt = (text: string, outcome: string, taskId: string | null = null, terminal: "done" | "failed" = "done") =>
      this.persist(input, canonical, { kind: "decide" }, terminal, taskId, text, outcome);
    const c = this.deps.store.getConfirmation(command.confirmationId);
    if (!c || !this.eligible(c, input)) {
      return receipt(`审批 ${command.confirmationId} 不存在或不属于本入口；未执行。`, "not_found");
    }
    if (c.status !== "pending") {
      return receipt(`审批 ${c.id} 已失效或已处理（当前 ${c.status}）；未按本条命令执行。`, "already_decided", c.taskId);
    }
    if (c.permissionVersion !== command.permissionVersion) {
      return receipt(
        `审批 ${c.id} 的权限版本现在是 v${c.permissionVersion}（命令中为 v${command.permissionVersion}）；未执行。请先用 /approval ${c.id} 查看后再决定。`,
        "version_mismatch",
        c.taskId,
      );
    }
    const task = this.deps.store.getTask(c.taskId);
    if (!task || task.status !== "awaiting_confirmation") {
      return receipt(`审批 ${c.id} 已失效（任务${task ? `状态 ${task.status}` : "不存在"}）；未执行。`, "stale", c.taskId);
    }
    const text =
      command.decision === "approved"
        ? `已接受批准：${c.toolName}（审批 ${c.id}，权限版本 v${c.permissionVersion}）。执行前仍按当前绑定与权限复核，结果经原入口回复；批准接受不等于操作已成功。`
        : `已拒绝：${c.toolName}（审批 ${c.id}，权限版本 v${c.permissionVersion}）。操作不会执行。`;
    let applied: boolean;
    try {
      applied = this.deps.applyDecision(c, command.decision, () => {
        this.persistTx(input, canonical, { kind: "decide" }, "done", c.taskId, text, command.decision);
      });
    } catch (err) {
      // 决定/回执中途写失败全部回滚（决定未记录）；如实告知（本条记录为失败终态，
      // 重投只读它；恢复后需重新发送命令才有新的执行机会）
      try {
        return receipt(`审批 ${c.id} 的${command.decision === "approved" ? "批准" : "拒绝"}处理失败（未记录决定）：${(err as Error).message.slice(0, 120)}。后台恢复后请重新发送本命令。`, "failed", c.taskId, "failed");
      } catch {
        throw err;
      }
    }
    if (!applied) {
      return receipt(`审批 ${c.id} 已失效或已被其他入口（TUI/自动审查/另一条命令）处理；未按本条命令执行。`, "race_lost", c.taskId);
    }
    // 决定、审计事件、控制事件终态与回执已同事务提交；等待者已在提交后唤醒
    const event = this.deps.store.findInboundEvent(input.source, input.externalId);
    return { control: true, eventId: event?.id ?? null, outcome: command.decision };
  }

  // ---------- 长期操作授权（agent-direction issue 10） ----------

  /**
   * /approve-standing：明确表示"保存持续授权并批准这一次"。创建只接受当前
   * pending 的 service_manage + service_operation + restart 审批，范围完全来自
   * 原不可变记录（机器/单元/固定动作/两项修订），不接受用户或模型新参数；授权、
   * 当前决定与授权关联、审计事件、控制事件终态与回执在同一事务提交，任何一步
   * 失败全部回滚。原 /approve 仍只批准一次，绝不隐式保存长期授权。
   */
  private handleApproveStanding(
    input: ImControlInput,
    canonical: string,
    command: Extract<ImApprovalCommand, { kind: "approve-standing" }>,
  ): ImCommandOutcome {
    const receipt = (text: string, outcome: string, taskId: string | null = null, terminal: "done" | "failed" = "done") =>
      this.persist(input, canonical, { kind: "approve-standing" }, terminal, taskId, text, outcome);
    const c = this.deps.store.getConfirmation(command.confirmationId);
    if (!c || !this.eligible(c, input)) {
      return receipt(`审批 ${command.confirmationId} 不存在或不属于本入口；未执行。`, "not_found");
    }
    if (c.status !== "pending") {
      return receipt(`审批 ${c.id} 已失效或已处理（当前 ${c.status}）；不会重复保存授权。`, "already_decided", c.taskId);
    }
    if (c.permissionVersion !== command.permissionVersion) {
      return receipt(
        `审批 ${c.id} 的权限版本现在是 v${c.permissionVersion}（命令中为 v${command.permissionVersion}）；未执行。请先用 /approval ${c.id} 查看后再决定。`,
        "version_mismatch",
        c.taskId,
      );
    }
    if (c.toolName !== "service_manage" || c.scope.kind !== "service_operation" || c.scope.action !== "restart") {
      return receipt(`审批 ${c.id} 不是服务 restart 审批（长期授权首版只保存对本机白名单服务的 restart）；未执行。`, "not_service_scope", c.taskId);
    }
    const task = this.deps.store.getTask(c.taskId);
    if (!task || task.status !== "awaiting_confirmation") {
      return receipt(`审批 ${c.id} 已失效（任务${task ? `状态 ${task.status}` : "不存在"}）；未执行。`, "stale", c.taskId);
    }
    // 活动 main 绑定核实（服务工具只对 main 装配；共享主会话不改变授权归属）
    const identity = this.deps.store.getSessionIdentity(c.sessionId);
    if (identity?.kind !== "main") {
      return receipt(`审批 ${c.id} 不属于 main 会话；未执行。`, "not_main", c.taskId);
    }
    const scope = c.scope;
    // 部署策略同步重读：授权范围钉版当前真实修订（修订变化需重新检查后申请）
    const policyNow = this.deps.servicePolicyRevision?.() ?? null;
    if (policyNow === null) {
      return receipt(`本机未配置服务管理能力或策略不可核对；未保存授权。`, "no_service_capability", c.taskId);
    }
    if (policyNow !== scope.policyRevision) {
      return receipt(`服务管理策略与审批请求时已不同（请重新检查后再申请）；未保存授权。`, "policy_changed", c.taskId);
    }
    // 同目标历史效果未知操作（拥有者核实参照；不是创建依据，也不能由宿主自动续建代替）
    const unknownOps = this.deps.store
      .listEffectUnknownToolOps("service_manage", 5)
      .filter((op) => op.params["unit"] === scope.unit);
    const unknownNote = unknownOps.length
      ? `\n注意：该目标存在 ${unknownOps.length} 项结果未知的历史操作（${unknownOps.map((o) => o.id).join(", ")}）。请核实其实际效果后再依赖本授权；本授权不代替核实。`
      : "";
    const successText = (sp: StandingPermission): string =>
      `长期授权已保存：${sp.id} v1（本机 restart ${scope.unit}；策略/单元修订已钉版；绑定本入口）。` +
      `\n本次批准已接受：不代表操作已经成功，执行结果经原入口回复。` +
      `\n有效期：持续到撤销、修订变化、入口绑定变化或目标效果未知。` +
      `\n查看：/service-grant ${sp.id}｜撤销：/revoke-service-grant ${sp.id} 1${unknownNote}`;
    let applied: boolean;
    try {
      applied = this.deps.applyDecision(c, "approved", () => {
        // 同事务编排：控制事件终态登记 → 授权（来源审批唯一）→ 固定目标回执 + 审计事件
        const { event } = this.deps.store.registerInboundEvent({
          source: input.source,
          externalId: input.externalId,
          actor: input.actor,
          targetRole: "main",
          body: canonical,
          replyTarget: input.replyTarget,
          eventKind: "im_approval",
          terminal: "done",
        });
        const sp = this.deps.store.createStandingPermission({
          sessionId: c.sessionId,
          projectId: identity.role.projectId,
          machineId: scope.machineId,
          unit: scope.unit,
          action: "restart",
          policyRevision: scope.policyRevision,
          unitRevision: scope.unitRevision,
          channel: input.source,
          account: input.replyTarget!.account,
          chatId: input.replyTarget!.chatId,
          actor: input.actor!,
          pinnedTarget: input.replyTarget!,
          approvalId: c.id,
          createdByEventId: event.id,
        });
        this.deps.sched.insertOp({
          sourceKind: "inbound_event",
          sourceKey: event.id,
          taskId: c.taskId,
          hostOpId: null,
          target: input.replyTarget!,
          text: this.cap(input.source, successText(sp)),
          sourceRefs: [],
        });
        this.deps.store.appendEvent({ type: "im_approval.processed", eventId: event.id, source: input.source, commandKind: "approve-standing", outcome: "standing_created" }, {});
        return { standingPermission: { id: sp.id, version: sp.version } };
      });
    } catch (err) {
      // 创建/决定/关联/控制回执任一步中途写失败全部回滚（决定未记录、授权未保存）
      try {
        return receipt(`长期批准处理失败（未记录决定、未保存授权）：${(err as Error).message.slice(0, 120)}。后台恢复后请重新发送本命令。`, "failed", c.taskId, "failed");
      } catch {
        throw err;
      }
    }
    if (!applied) {
      return receipt(`审批 ${c.id} 已失效或已被其他入口（TUI/自动审查/另一条命令）处理；未保存授权。`, "race_lost", c.taskId);
    }
    const event = this.deps.store.findInboundEvent(input.source, input.externalId);
    return { control: true, eventId: event?.id ?? null, outcome: "standing_created" };
  }

  /** 授权行是否属于本命令的入口稳定身份（channel/account/chatId/actor；不含配置代次）。 */
  private belongsToEntry(sp: StandingPermission, input: ImControlInput): boolean {
    return sp.channel === input.source && sp.account === input.replyTarget!.account && sp.chatId === input.replyTarget!.chatId && sp.actor === input.actor;
  }

  /** 本入口稳定身份过滤（稳定 channel/account/chat/actor；入口代次状态单独标注）。 */
  private grantsForEntry(input: ImControlInput): StandingPermission[] {
    const out: StandingPermission[] = [];
    let before: string | undefined;
    for (let walk = 0; walk < 200; walk++) {
      const page = this.deps.store.listStandingPermissionsPaged({
        channel: input.source,
        account: input.replyTarget!.account,
        chatId: input.replyTarget!.chatId,
        actor: input.actor!,
        ...(before ? { before } : {}),
        limit: 50,
      });
      out.push(...page.items);
      if (!page.hasMore || page.items.length === 0) break;
      before = page.items[page.items.length - 1]!.id;
    }
    return out;
  }

  /** 授权状态文案：撤销/失效原因与"入口已失效"如实区分。 */
  private grantStatusLine(sp: StandingPermission): string {
    if (sp.revokedAt !== null) {
      const reason =
        sp.revokedReason === "owner_revoked"
          ? "已撤销（拥有者撤销）"
          : sp.revokedReason === "effect_unknown"
            ? "已失效（目标效果未知，需核实后重新建立）"
            : sp.revokedReason === "entry_changed"
              ? "已失效（入口绑定/代次变化）"
              : "已失效（策略或单元修订变化）";
      return `${reason} · 版本 v${sp.version}`;
    }
    const entry = this.deps.entry(sp.channel);
    const current = entry?.target() ?? null;
    const entryAlive = current !== null && sameTarget(current, sp.pinnedTarget) && sp.actor === entry?.expectedActor();
    return entryAlive ? `有效 · 版本 v${sp.version}` : `入口已失效 · 版本 v${sp.version}（入口代次不再一致，不能放行）`;
  }

  private handleGrants(input: ImControlInput, canonical: string, command: { kind: "grants"; page: number }): ImCommandOutcome {
    const grants = this.grantsForEntry(input);
    const total = grants.length;
    const pages = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
    const lines: string[] = [];
    if (total === 0) {
      lines.push("本入口没有保存的长期授权。");
    } else if (command.page >= pages) {
      lines.push(`本入口长期授权共 ${total} 项（第 ${command.page}/${pages - 1} 页为空）。`);
    } else {
      lines.push(`本入口长期授权 ${total} 项（第 ${command.page}/${pages - 1} 页）：`);
      grants.slice(command.page * LIST_PAGE_SIZE, command.page * LIST_PAGE_SIZE + LIST_PAGE_SIZE).forEach((sp, i) => {
        lines.push(`${command.page * LIST_PAGE_SIZE + i + 1}. ${sp.id}`);
        lines.push(`   ${sp.action} ${sp.unit}｜${this.grantStatusLine(sp)}`);
      });
    }
    lines.push("详情：/service-grant <授权ID> [偏移]｜撤销：/revoke-service-grant <授权ID> <版本>");
    if (total > 0 && command.page < pages - 1) lines.push(`下一页：/service-grants ${command.page + 1}`);
    return this.persist(input, canonical, { kind: "grants" }, "done", null, lines.join("\n"), "listed");
  }

  private handleGrantDetail(
    input: ImControlInput,
    canonical: string,
    command: { kind: "grant-detail"; permissionId: string; offset: number },
  ): ImCommandOutcome {
    const sp = this.deps.store.getStandingPermission(command.permissionId);
    if (!sp || !this.belongsToEntry(sp, input)) {
      return this.persist(input, canonical, { kind: "grant-detail" }, "done", null,
        `长期授权 ${command.permissionId} 不存在或不属于本入口；未经核实身份不提供详情。`, "not_found");
    }
    const usages = this.deps.store.listConfirmationsByStanding(sp.id, 100);
    const lines: string[] = [
      `长期授权 ${sp.id}`,
      `范围：本机 ${sp.machineId.slice(0, 12)}… 对 ${sp.unit} 执行 ${sp.action}（root 提权经后台固定 helper）`,
      `修订钉版：策略 ${sp.policyRevision.slice(0, 12)}…｜单元 ${sp.unitRevision.slice(0, 12)}…`,
      `状态：${this.grantStatusLine(sp)}`,
      `来源：审批 ${sp.approvalId}｜创建 ${sp.createdAt}${sp.revokedAt ? `｜撤销/失效 ${sp.revokedAt}` : ""}`,
      `存续条件：持续到撤销、修订变化、入口绑定变化或目标效果未知；绑定平台 ${sp.channel} 账号 ${sp.account} 会话 ${sp.chatId}（${sp.actor}）`,
    ];
    if (usages.length === 0) {
      lines.push("使用记录：尚无独立批准/消费。");
    } else if (command.offset < usages.length) {
      const pageUsages = usages.slice(command.offset, command.offset + USAGE_PAGE_SIZE);
      lines.push(`使用记录 ${usages.length} 次（第 ${command.offset}–${command.offset + pageUsages.length - 1} 条，新 → 旧）：`);
      pageUsages.forEach((c) => {
        lines.push(`- 审批 ${c.id}｜操作 ${c.toolOpId}｜${c.status}${c.consumedAt ? "（已消费）" : ""}`);
      });
      if (command.offset + pageUsages.length < usages.length) {
        lines.push(`继续：/service-grant ${sp.id} ${command.offset + pageUsages.length}`);
      }
    } else {
      lines.push(`使用记录共 ${usages.length} 次（偏移 ${command.offset} 超出范围）。`);
    }
    lines.push(`撤销：/revoke-service-grant ${sp.id} ${sp.version}`);
    return this.persist(input, canonical, { kind: "grant-detail" }, "done", null, lines.join("\n"), "detailed");
  }

  private handleRevokeGrant(
    input: ImControlInput,
    canonical: string,
    command: Extract<ImApprovalCommand, { kind: "revoke-grant" }>,
  ): ImCommandOutcome {
    const receipt = (text: string, outcome: string, taskId: string | null = null) =>
      this.persist(input, canonical, { kind: "revoke-grant" }, "done", taskId, text, outcome);
    const sp = this.deps.store.getStandingPermission(command.permissionId);
    if (!sp || !this.belongsToEntry(sp, input)) {
      return receipt(`长期授权 ${command.permissionId} 不存在或不属于本入口；未执行。`, "not_found");
    }
    if (sp.revokedAt === null && sp.version !== command.expectedVersion) {
      return receipt(
        `长期授权 ${sp.id} 的版本现在是 v${sp.version}（命令中为 v${command.expectedVersion}）；未执行。请先用 /service-grant ${sp.id} 查看后再撤销。`,
        "version_mismatch",
      );
    }
    try {
      const { changed } = this.deps.store.withTx(() => {
        const result = this.deps.store.revokeStandingPermission(sp.id, sp.revokedAt === null ? command.expectedVersion : sp.version);
        this.persistTx(input, canonical, { kind: "revoke-grant" }, "done", null,
          result.changed
            ? `已撤销长期授权 ${sp.id}（v${sp.version} → v${sp.version + 1}；范围：本机 restart ${sp.unit}）。后续独立任务恢复人工审批（不代表正在执行的操作被取消）。`
            : `长期授权 ${sp.id} 此前已撤销/失效（当前 v${result.permission.version}，原因 ${result.permission.revokedReason}）；未再次变更。`,
          result.changed ? "revoked" : "already_revoked");
        return result;
      });
      this.deps.kickSender();
      const event = this.deps.store.findInboundEvent(input.source, input.externalId);
      return { control: true, eventId: event?.id ?? null, outcome: changed ? "revoked" : "already_revoked" };
    } catch (err) {
      if ((err as { code?: string }).code === "version_conflict") {
        const current = this.deps.store.getStandingPermission(sp.id);
        return receipt(`长期授权 ${sp.id} 版本与记录不符（当前 v${current?.version}）；未执行。`, "version_mismatch");
      }
      throw err;
    }
  }

  // ---------- 归属核实 ----------

  /**
   * 从任务沿已记录 parentTaskId 找到根任务的来源入站事件（IM 委托）。
   * 断链、循环、无来源或来源不是普通任务入站一律返回 null；不从会话最近
   * 消息推断归属。命令归属核实、审批创建通知与消费前复核共用。
   */
  private imSource(taskId: string): ImApprovalSource | null {
    let task: Task | null = this.deps.store.getTask(taskId);
    if (!task) return null;
    const seen = new Set<string>([task.id]);
    for (let depth = 0; task.parentTaskId; depth++) {
      if (depth >= CHAIN_WALK_LIMIT) return null;
      const parent = this.deps.store.getTask(task.parentTaskId);
      if (!parent || seen.has(parent.id)) return null;
      seen.add(parent.id);
      task = parent;
    }
    if (!task.sourceEventId) return null;
    const event = this.deps.store.getInboundEvent(task.sourceEventId);
    if (!event || event.eventKind !== "task") return null;
    if (event.source === "scheduler") {
      const identity = this.deps.store.getSessionIdentity(task.sessionId);
      if (identity?.kind !== "scheduled" || identity.rootTaskId !== task.id) return null;
      const run = this.deps.sched.getRun(identity.runId);
      const schedule = this.deps.sched.getSchedule(identity.scheduleId);
      if (!run || run.rootTaskId !== task.id || run.inboundEventId !== event.id || !schedule?.target) return null;
      return { source: schedule.target.channel, actor: this.deps.entry(schedule.target.channel)?.expectedActor() ?? null,
        replyTarget: schedule.target, inboundEvent: null };
    }
    if (event.source !== "telegram" && event.source !== "qq_private") return null;
    if (!event.actor || !event.replyTarget) return null;
    return { source: event.source, actor: event.actor, replyTarget: event.replyTarget, inboundEvent: event };
  }

  /** 审批是否属于本命令的固定身份：同平台、同 actor、同钉版目标（含配置版本）。 */
  private eligible(confirmation: ConfirmationRequest, input: ImControlInput): boolean {
    if (!input.replyTarget) return false;
    const event = this.imSource(confirmation.taskId);
    if (!event || event.source !== input.source || event.actor !== input.actor) return false;
    return sameTarget(event.replyTarget!, input.replyTarget);
  }

  // ---------- 持久化 ----------

  /** 控制事件 + 终态 + 回执在同一事务落盘；提交后唤醒发送器。 */
  private persist(
    input: ImControlInput,
    canonical: string,
    command: { kind: string },
    terminal: "done" | "failed",
    taskId: string | null,
    text: string,
    outcome: string,
  ): ImCommandOutcome {
    const eventId = this.deps.store.withTx(() => this.persistTx(input, canonical, command, terminal, taskId, this.cap(input.source, text), outcome));
    this.deps.kickSender();
    return { control: true, eventId, outcome };
  }

  /** 无钉版目标时的最小控制记录（无回执渠道）：只落控制事件与审计。 */
  private persistNoReceipt(input: ImControlInput, canonical: string, command: { kind: string }, outcome: string): ImCommandOutcome {
    const eventId = this.deps.store.withTx(() => {
      const { event } = this.deps.store.registerInboundEvent({
        source: input.source,
        externalId: input.externalId,
        actor: input.actor,
        targetRole: "main",
        body: canonical,
        replyTarget: null,
        eventKind: "im_approval",
        terminal: "failed",
      });
      this.deps.store.appendEvent({ type: "im_approval.processed", eventId: event.id, source: input.source, commandKind: command.kind, outcome }, {});
      return event.id;
    });
    return { control: true, eventId, outcome };
  }

  /** 事务内部分（decide 时作为 txExtra 并入决定事务；调用方必须已在 withTx 内）。 */
  private persistTx(
    input: ImControlInput,
    canonical: string,
    command: { kind: string },
    terminal: "done" | "failed",
    taskId: string | null,
    text: string,
    outcome: string,
  ): string {
    const { event } = this.deps.store.registerInboundEvent({
      source: input.source,
      externalId: input.externalId,
      actor: input.actor,
      targetRole: "main",
      body: canonical,
      replyTarget: input.replyTarget,
      eventKind: "im_approval",
      terminal,
    });
    this.deps.sched.insertOp({
      sourceKind: "inbound_event",
      sourceKey: event.id,
      taskId,
      hostOpId: null,
      target: input.replyTarget!,
      text: this.cap(input.source, text),
      sourceRefs: [],
    });
    this.deps.store.appendEvent({ type: "im_approval.processed", eventId: event.id, source: input.source, commandKind: command.kind, outcome }, {});
    return event.id;
  }

  // ---------- 文本模板（宿主写定；参数与范围作为数据展示，不由模型改写） ----------

  private usageText(): string {
    return "用法：/approvals [页码]｜/approval <审批ID> [偏移]｜/approve <审批ID> <权限版本>｜/reject <审批ID> <权限版本>｜/approve-standing <审批ID> <权限版本>（保存服务 restart 长期授权并批准本次）｜/service-grants [页码]｜/service-grant <授权ID> [偏移]｜/revoke-service-grant <授权ID> <版本>";
  }

  private briefParams(c: ConfirmationRequest, cap: number): string {
    const json = JSON.stringify(c.params);
    return [...json].length <= cap ? json : `${this.capText(json, cap)}（截断，详情 /approval ${c.id}）`;
  }

  private detailText(source: string, c: ConfirmationRequest, offset: number): string {
    const head = [
      `审批 ${c.id}（${c.status}）`,
      `工具 ${c.toolName}｜权限版本 v${c.permissionVersion}`,
      `任务 ${c.taskId}`,
      `范围：${this.capText(JSON.stringify(c.scope), 300)}`,
    ];
    // 同目标历史效果未知操作（issue 10）：批准前的核实参照
    if (c.status === "pending" && c.scope.kind === "service_operation") {
      const scope = c.scope;
      const unknown = this.deps.store.listEffectUnknownToolOps("service_manage", 5).filter((op) => op.params["unit"] === scope.unit && op.params["machine_id"] === scope.machineId);
      if (unknown.length) {
        head.push(`注意：该目标存在 ${unknown.length} 项结果未知的历史操作（${unknown.map((o) => o.id).join(", ")}）；长期授权或批准前请先核实其实际效果，授权不代替核实。`);
      }
    }
    const tail = [
      `查看全部后用：批准（仅本次）/approve ${c.id} ${c.permissionVersion}｜拒绝 /reject ${c.id} ${c.permissionVersion}`,
      ...(c.scope.kind === "service_operation" && c.status === "pending"
        ? [`长期批准（保存本机 restart ${c.scope.unit} 授权并批准本次，撤销或变化前长期有效）：/approve-standing ${c.id} ${c.permissionVersion}`]
        : []),
    ];
    // 字节 ≤ 字符数：按字节分段天然不超字符上限（UTF-8 每字符至少 1 字节）
    const capChars = this.replyCapChars(source);
    const headChars = [...head.join("\n")].length;
    const tailReserve = [...tail[0]!].length + 120;
    const budget = Math.max(100, capChars - headChars - tailReserve);
    const json = JSON.stringify(c.params);
    const seg = sliceTextByBytes(json, offset, budget);
    const segBytes = Buffer.byteLength(seg.text, "utf8");
    const atEnd = seg.offset + segBytes >= seg.totalBytes;
    const lines = [...head, `参数（字节 ${seg.offset}–${seg.offset + segBytes}，共 ${seg.totalBytes}：${atEnd ? "已到末尾" : "非最后一段，须继续读完再决定"}）：`, seg.text];
    if (!atEnd) lines.push(`继续：/approval ${c.id} ${seg.offset + segBytes}`);
    lines.push(...tail);
    return lines.join("\n");
  }

  private cap(source: string, text: string): string {
    return this.capText(text, this.replyCapChars(source));
  }

  private replyCapChars(source: string): number {
    return this.deps.entry(source)?.replyCapChars() ?? 4000;
  }

  private capText(text: string, cap: number): string {
    const chars = [...text];
    return chars.length <= cap ? text : `${chars.slice(0, Math.max(1, cap - 1)).join("")}…`;
  }
}
