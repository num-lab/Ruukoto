/**
 * 工具操作账本（架构工单 05）：工具操作的已知结果与效果未知只在这里写，停止与
 * 重启按同一个分类器补记结果缺失的操作。
 *
 * - 结果与 `task.tool_result` 事件成对写入，落库与事件是同一句；条件更新以
 *   先写者为准，重复补记不重复发布；
 * - 效果未知：操作标记 + `task.tool_effect_unknown` + 任务标记，已标记即跳过；
 * - 分类（对结果缺失、未标未知的操作，停止与重启同一个）：
 *   1. 有审批且全部未消费 → 已知未执行（批准没消费即证明没执行，证据强于其余各条）；
 *   2. 无写入效果的工具 → 「未完成：只读操作…中止，无写入效果」；
 *   3. 工具族能按宿主操作 ID 核实 → 已提交 / 已知未提交；无法核实 → 效果未知；
 *   4. 其余 → 效果未知（不重放，由拥有者核实）。
 *
 * 规则表按静态工具名穷尽登记（漏登记即编译错误）；MCP 动态工具与未登记名字按
 * 审批判定。记忆族不登记核实：`memory_revoke` 只改状态、不写带 tool_op_id 的
 * 版本行，无法从磁盘证明撤销已发生。MCP 读工具的副作用类别不在 tool_ops 里，
 * 重启时拿不到钉版计划，也按审批判定。
 *
 * 调用方负责事务（重启恢复在恢复事务内调用，`Db.tx` 不能嵌套）。
 */

import type { Store } from "../core/store.ts";
import type { ConfirmationRequest, EditStats, ToolOp } from "../core/types.ts";
// 名字常量只用于规则表的穷尽类型（type-only：不引入运行时依赖）
import type { APPROVAL_TOOL_NAMES, ARTIFACT_TOOL_NAME, CODING_TOOL_NAMES } from "./tool-router.ts";
import type { HOST_DATA_TOOL_NAMES } from "./host-tools.ts";
import type { WEB_SEARCH_TOOL_NAMES } from "./web-search.ts";
import type { SKILL_TOOL_NAMES } from "./skills.ts";
import type { TODO_TOOL_NAMES } from "./todo.ts";
import type { APP_DATA_TOOL_NAMES } from "./app-data/tools.ts";
import type { SCHEDULER_TOOL_NAMES } from "./scheduler-tools.ts";
import type { DELEGATION_TOOL_NAMES } from "./delegation-tools.ts";
import type { CHAT_RESULT_TOOL_NAMES } from "./chat-result-tools.ts";
import type { MOCK_TOOL_NAMES } from "./mock-tools.ts";

type TaskRef = { id: string; sessionId: string };

export type ToolOpFamily = "app_data" | "scheduler" | "delegation" | "chat_result";

/** 工具族的核实：写操作是否已提交，及两种结论的证据文案（`when` 如「停止前」）。 */
export interface FamilyCheck {
  verify(op: ToolOp): "committed" | "not_committed" | "unverifiable";
  committed(when: string): string;
  notCommitted(when: string): string;
}

type StaticToolName =
  | (typeof CODING_TOOL_NAMES)[number]
  | (typeof APPROVAL_TOOL_NAMES)[number]
  | typeof ARTIFACT_TOOL_NAME
  | (typeof HOST_DATA_TOOL_NAMES)[number]
  | (typeof WEB_SEARCH_TOOL_NAMES)[number]
  | (typeof SKILL_TOOL_NAMES)[number]
  | (typeof TODO_TOOL_NAMES)[number]
  | (typeof APP_DATA_TOOL_NAMES)[number]
  | (typeof SCHEDULER_TOOL_NAMES)[number]
  | (typeof DELEGATION_TOOL_NAMES)[number]
  | (typeof CHAT_RESULT_TOOL_NAMES)[number]
  | (typeof MOCK_TOOL_NAMES)[number];

type Rule = "no_effect" | "approval" | ToolOpFamily;

const RULES: Record<StaticToolName, Rule | ((params: Record<string, unknown>) => Rule)> = {
  read: "no_effect",
  edit: "approval",
  write: "approval",
  bash: "approval",
  request_file_access: (p) => (p.operation === "write" ? "approval" : "no_effect"),
  http_request: (p) => (["GET", "HEAD"].includes(String(p.method ?? "").toUpperCase()) ? "no_effect" : "approval"),
  read_artifact: "no_effect",
  history_search: "no_effect",
  history_read: "no_effect",
  memory_list: "no_effect",
  memory_read: "no_effect",
  memory_save: "approval",
  memory_revoke: "approval",
  web_search: "no_effect",
  skill: "no_effect",
  // 清单不另存，只由成功调用的参数推出：未完成的调用没有效果
  todo_write: "no_effect",
  app_data_query: "no_effect",
  app_data_define_table: "app_data",
  app_data_migrate: "app_data",
  app_data_insert: "app_data",
  app_data_update: "app_data",
  app_data_delete: "app_data",
  schedule_query: "no_effect",
  notification_query: "no_effect",
  schedule_create: "scheduler",
  schedule_cancel: "scheduler",
  notification_enqueue: "scheduler",
  notification_cancel: "scheduler",
  coding_result: "no_effect",
  coding_delegate: "delegation",
  chat_result_list: "no_effect",
  chat_result_accept: "chat_result",
  // 模拟工具代表可能有副作用的通用工具（mock_mark 写外部标记）
  mock_delay: "approval",
  mock_gate: "approval",
  mock_spawn: "approval",
  mock_mark: "approval",
};

function ruleOf(op: Pick<ToolOp, "toolName" | "params">): Rule {
  // 动态名字（MCP）与未登记名字按审批判定；hasOwn 防原型链上的键
  if (!Object.hasOwn(RULES, op.toolName)) return "approval";
  const rule = RULES[op.toolName as StaticToolName];
  return typeof rule === "function" ? rule(op.params) : rule;
}

/** 该操作是否不产生写入效果（编排器的重试门共用）。 */
export function hasNoWriteEffect(op: Pick<ToolOp, "toolName" | "params">): boolean {
  return ruleOf(op) === "no_effect";
}

const OCCASIONS = {
  stop: { when: "停止前", notExecuted: "已知未执行：审批未消费即停止" },
  restart: { when: "后台重启前", notExecuted: "已知未执行：审批未消费即发生后台重启（批准不跨重启执行）" },
} as const;

function approvalUnconsumed(op: ToolOp, confirmations: ConfirmationRequest[]): boolean {
  const own = confirmations.filter((c) => c.toolOpId === op.id);
  return own.length > 0 && own.every((c) => c.consumedAt === null);
}

export class ToolOpLedger {
  constructor(
    readonly store: Store,
    private readonly families: Partial<Record<ToolOpFamily, FamilyCheck>> = {},
  ) {}

  recordResult(
    task: TaskRef,
    opId: string,
    summary: string,
    isError: boolean,
    extra: { artifactIds?: string[]; editStats?: EditStats } = {},
  ): boolean {
    if (!this.store.recordToolResult(opId, summary, isError)) return false;
    this.store.appendEvent(
      {
        type: "task.tool_result",
        taskId: task.id,
        toolOpId: opId,
        summary,
        isError,
        artifactIds: extra.artifactIds ?? [],
        ...(extra.editStats ? { editStats: extra.editStats } : {}),
      },
      { taskId: task.id, sessionId: task.sessionId },
    );
    return true;
  }

  markEffectUnknown(task: TaskRef, opId: string): boolean {
    const op = this.store.getToolOp(opId);
    if (!op || op.effectUnknown) return false;
    this.store.markToolOpEffectUnknown(opId);
    this.store.appendEvent(
      { type: "task.tool_effect_unknown", taskId: task.id, toolOpId: opId, toolName: op.toolName },
      { taskId: task.id, sessionId: task.sessionId },
    );
    this.store.setEffectUnknown(task.id);
    return true;
  }

  /**
   * 停止·中止前：按审批判定、结果缺失且执行可能已开始的操作。效果以停止瞬间为准：
   * 中止期间才落下的结果（如 bash 的「已中止」）说明不了效果，仍标未知。
   */
  beginStop(taskId: string): string[] {
    const confirmations = this.store.listConfirmationsByTask(taskId);
    return this.store
      .listUnresolvedToolOps(taskId)
      .filter((op) => ruleOf(op) === "approval" && !approvalUnconsumed(op, confirmations))
      .map((op) => op.id);
  }

  /**
   * 停止·中止后：结果缺失的操作按分类器补记已知结论；返回要在终态事务里标效果
   * 未知的操作（含快照）。终态被竞争路径抢先时由调用方放弃标记。
   */
  settleTask(task: TaskRef, snapshot: string[]): string[] {
    const confirmations = this.store.listConfirmationsByTask(task.id);
    const unknown = [...snapshot];
    for (const op of this.store.listUnresolvedToolOps(task.id)) {
      if (snapshot.includes(op.id)) continue;
      if (!this.recordKnown(task, op, confirmations, "stop")) unknown.push(op.id);
    }
    return unknown;
  }

  /** 重启：全部任务（含终态）里结果缺失的操作按同一分类器补记，不确定的标效果未知。 */
  settleAll(): void {
    const confirmationsByTask = new Map<string, ConfirmationRequest[]>();
    for (const op of this.store.listAllUnresolvedToolOps()) {
      const task = this.store.getTask(op.taskId);
      if (!task) continue;
      let confirmations = confirmationsByTask.get(task.id);
      if (!confirmations) {
        confirmations = this.store.listConfirmationsByTask(task.id);
        confirmationsByTask.set(task.id, confirmations);
      }
      if (!this.recordKnown(task, op, confirmations, "restart")) this.markEffectUnknown(task, op.id);
    }
  }

  /**
   * 核心结果写入失败：只对工具族能核实的操作即时补记（真实结果已拿到只是没写进去，
   * 其余标未知不对，留给重启）。
   */
  settleAfterWriteFailure(task: TaskRef, opId: string): void {
    const op = this.store.getToolOp(opId);
    if (!op || op.resultSummary !== null || op.effectUnknown) return;
    this.recordFamilyVerdict(task, op, "结果写入失败前");
  }

  /** 按分类器补记已知结论；返回 false = 效果未知。 */
  private recordKnown(task: TaskRef, op: ToolOp, confirmations: ConfirmationRequest[], occasion: keyof typeof OCCASIONS): boolean {
    const { when, notExecuted } = OCCASIONS[occasion];
    if (approvalUnconsumed(op, confirmations)) {
      this.recordResult(task, op.id, notExecuted, true);
      return true;
    }
    if (ruleOf(op) === "no_effect") {
      this.recordResult(task, op.id, `未完成：只读操作在${when}中止，无写入效果`, true);
      return true;
    }
    return this.recordFamilyVerdict(task, op, when);
  }

  private recordFamilyVerdict(task: TaskRef, op: ToolOp, when: string): boolean {
    const rule = ruleOf(op);
    const check = rule === "no_effect" || rule === "approval" ? undefined : this.families[rule];
    const verdict = check?.verify(op) ?? "unverifiable";
    if (!check || verdict === "unverifiable") return false;
    const committed = verdict === "committed";
    this.recordResult(task, op.id, committed ? check.committed(when) : check.notCommitted(when), !committed);
    return true;
  }
}
