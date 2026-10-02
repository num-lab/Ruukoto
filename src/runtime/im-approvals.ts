/**
 * IM 审批命令（agent-direction issue 08）：绑定拥有者在 QQ 私聊 / Telegram
 * 私聊中以整条文本命令查询、批准或拒绝已有审批请求。
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

import type { Store } from "../core/store.ts";
import type { ConfirmationRequest, InboundEvent, NotifyTarget, Task } from "../core/types.ts";
import { sameTarget } from "../core/notify-target.ts";
import { sliceTextByBytes } from "../core/history.ts";
import type { SchedulerStore } from "../scheduler/store.ts";

/** 每页列出的审批条数（有界分页）。 */
const LIST_PAGE_SIZE = 5;
/** 委派链追溯深度上限（断链/循环一律拒绝）。 */
const CHAIN_WALK_LIMIT = 16;
/** 分页参数上限（游标/偏移；超界按格式错误处理）。 */
const PAGE_ARG_MAX = 1_000_000;

export type ImApprovalCommand =
  | { kind: "list"; page: number }
  | { kind: "detail"; confirmationId: string; offset: number }
  | { kind: "decide"; decision: "approved" | "rejected"; confirmationId: string; permissionVersion: number }
  | { kind: "usage" };

const VERB = "(approvals|approval|approve|reject)";

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
  // approve / reject：完整审批 ID + 正整数权限版本，不接受部分 ID 或新参数
  if (args.length === 2) {
    const version = boundedInt(args[1]!);
    if (version !== null && version >= 1) {
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
  /** 当前有效固定目标（平台适配器 target()；null = 停用/凭据不可用）。 */
  currentTarget(source: string): NotifyTarget | null;
  /** 当前配置期望的 actor（owner 身份）；null = 未绑定，任何命令都不接纳。 */
  expectedActor(source: string): string | null;
  /** 单条回执字符上限（QQ 按配置、Telegram 按平台消息上限）。 */
  replyCapChars(source: string): number;
  /**
   * 决定执行：经活动 Driver 的审批闸门把决定、审计事件与 txExtra 在同一事务
   * 提交后唤醒等待者；返回 false = 无活动执行或已被其他入口处理。txExtra 抛错
   * 则决定整笔回滚并向上抛出。
   */
  applyDecision(confirmation: ConfirmationRequest, decision: "approved" | "rejected", txExtra: () => void): boolean;
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
    const current = this.deps.currentTarget(input.source);
    const expectedActor = this.deps.expectedActor(input.source);
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

  // ---------- 归属核实 ----------

  /**
   * 从任务沿已记录 parentTaskId 找到根任务的来源入站事件（IM 委托）。
   * 断链、循环、无来源或来源不是普通任务入站一律返回 null；不从会话最近
   * 消息推断归属。命令归属核实、审批创建通知与消费前复核共用。
   */
  imSourceEvent(taskId: string): InboundEvent | null {
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
    if (event.source !== "telegram" && event.source !== "qq_private") return null;
    if (!event.actor || !event.replyTarget) return null;
    return event;
  }

  /** 审批是否属于本命令的固定身份：同平台、同 actor、同钉版目标（含配置版本）。 */
  private eligible(confirmation: ConfirmationRequest, input: ImControlInput): boolean {
    if (!input.replyTarget) return false;
    const event = this.imSourceEvent(confirmation.taskId);
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
    return "用法：/approvals [页码]｜/approval <审批ID> [偏移]｜/approve <审批ID> <权限版本>｜/reject <审批ID> <权限版本>";
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
    const tail = [`查看全部后用：批准 /approve ${c.id} ${c.permissionVersion}｜拒绝 /reject ${c.id} ${c.permissionVersion}`];
    // 字节 ≤ 字符数：按字节分段天然不超字符上限（UTF-8 每字符至少 1 字节）
    const capChars = this.deps.replyCapChars(source);
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
    return this.capText(text, this.deps.replyCapChars(source));
  }

  private capText(text: string, cap: number): string {
    const chars = [...text];
    return chars.length <= cap ? text : `${chars.slice(0, Math.max(1, cap - 1)).join("")}…`;
  }
}
