/**
 * main 应用数据宿主工具（issue 02）：define_table / migrate / query / insert /
 * update / delete。模型侧统一 `app_data_` 前缀，避免与其他工具重名。
 *
 * - 身份由宿主注入（当前任务 → 会话 → main 角色绑定）；执行入口每次重新核实
 *   宿主任务、会话、项目与 main 角色绑定，工具参数不接受 agent/project/路径；
 * - 所有写入必须带非空 reason（≤1 KiB）；schema 校验在存储边界执行；
 * - 非破坏性变更自动执行；删除表/字段/唯一索引、多行写与批量重写进入
 *   统一审批桥（Driver.awaitApproval），批准单次消费、执行参数取自不可变快照；
 * - 应用数据保存待办/提醒/习惯等结构化记录；偏好、约定、决策、经验仍进入
 *   长期记忆（MemoryStore），应用记录不自动提升为长期记忆或控制指令；
 * - 调用门拒绝、校验失败、预算超限和超时留下可识别的 app_data.rejected 事件。
 */

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { Store } from "../../core/store.ts";
import type { ApprovalScope, Task } from "../../core/types.ts";
import type { ApprovalOutcome } from "../tool-router.ts";
import {
  AppDataConflictError,
  AppDataError,
  LIMITS,
  validateReason,
  type AppDataStore,
  type CatalogTable,
  type OpContext,
} from "./store.ts";
import { AppDataQueryRunner, validateQueryRequest, type RunnerOptions } from "./query.ts";

import type { HostToolContext } from "../host-tools.ts";

/** 应用数据工具的执行上下文（身份由宿主注入，不从工具参数取得）。 */
export type AppToolContext = HostToolContext;

export interface AppDataToolsDeps {
  store: AppDataStore;
  runner: AppDataQueryRunner;
  /** 核心库：app_data.rejected / approval_consumed 事件与审批消费。 */
  coreStore: Store;
  /** 当前调用上下文（宿主注入；绑定一次工具调用）。 */
  taskContext(): AppToolContext | null;
  /** 绑定一次工具调用的上下文；返回解除函数。 */
  bindCall?(sdkCallId: string): () => void;
  /** 执行入口每次重新核实宿主任务/会话/项目与 main 角色绑定；null=通过。 */
  verifyMain(ctx: AppToolContext): string | null;
  /** 统一审批桥（Driver.awaitApproval 的窄回调；不向模型暴露控制面）。 */
  awaitApproval(input: {
    task: Task;
    hostOpId: string;
    toolName: string;
    params: Record<string, unknown>;
    scope: ApprovalScope;
    signal?: AbortSignal;
  }): Promise<ApprovalOutcome>;
  /** 测试注入：查询子进程挂点（模型不可达）。 */
  queryStallMs?: () => number | undefined;
}

export const APP_DATA_TOOL_NAMES = [
  "app_data_define_table",
  "app_data_migrate",
  "app_data_query",
  "app_data_insert",
  "app_data_update",
  "app_data_delete",
] as const;

/**
 * 恢复/停止路径共用（issue 02）：按应用库回执核实未落结果的应用数据写操作
 * 并补记结果。调用方负责事务（Runtime.recover 在恢复事务内；Driver 停止路径
 * 自行 withTx）。recordToolResult 条件更新保证重复恢复不重复发布。
 */
export function settleAppDataOp(
  coreStore: Store,
  verdict: "committed" | "not_committed",
  task: { id: string; sessionId: string },
  op: { id: string },
  when: string,
): void {
  const summary =
    verdict === "committed"
      ? `已提交：应用库存在该操作回执（${when}已生效）`
      : `已知未提交：应用库无该操作回执（${when}未生效）`;
  const recorded = coreStore.recordToolResult(op.id, summary, verdict !== "committed");
  if (recorded) {
    coreStore.appendEvent(
      { type: "task.tool_result", taskId: task.id, toolOpId: op.id, summary, isError: verdict !== "committed", artifactIds: [] },
      { taskId: task.id, sessionId: task.sessionId },
    );
  }
}

/** 会产生写入效果的应用数据工具（恢复时按回执核实；query 是只读）。 */
export const APP_DATA_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "app_data_define_table",
  "app_data_migrate",
  "app_data_insert",
  "app_data_update",
  "app_data_delete",
]);

function okText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createAppDataTools(deps: AppDataToolsDeps): ToolDefinition[] {
  const requireCtx = (): AppToolContext => {
    const ctx = deps.taskContext();
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(
    fn: (params: P) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => {
    return async (sdkCallId: string, params: P) => {
      const unbind = deps.bindCall?.(sdkCallId) ?? (() => {});
      try {
        return await fn(params);
      } finally {
        unbind();
      }
    };
  };

  /** 拒绝：留 app_data.rejected 事件（只记来源/类别/错误码，不复制超长输入）。 */
  const reject = (
    ctx: AppToolContext | null,
    toolName: string,
    source: "identity" | "validation" | "budget" | "timeout",
    code: string,
    message: string,
  ): never => {
    try {
      deps.coreStore.withTx(() => {
        deps.coreStore.appendEvent(
          { type: "app_data.rejected", taskId: ctx?.taskId ?? null, sessionId: ctx?.sessionId ?? null, source, toolName, code },
          ctx ? { taskId: ctx.taskId, sessionId: ctx.sessionId } : {},
        );
      });
    } catch {
      // 事件落盘失败不阻断拒绝路径
    }
    throw new Error(message);
  };

  const fail = (err: unknown, ctx: AppToolContext | null, toolName: string): never => {
    if (err instanceof AppDataConflictError) {
      throw new Error(`${err.message}（当前版本：${JSON.stringify(err.current)}）`);
    }
    if (err instanceof AppDataError) {
      const source = err.code === "query_timeout" ? ("timeout" as const) : ("validation" as const);
      reject(ctx, toolName, source, err.code, err.message);
    }
    throw err instanceof Error ? err : new Error(String(err));
  };

  const checkIdentity = (ctx: AppToolContext, toolName: string): void => {
    const problem = deps.verifyMain(ctx);
    if (problem) reject(ctx, toolName, "identity", "identity_mismatch", problem);
  };

  const opCtx = (ctx: AppToolContext): OpContext => ({
    taskId: ctx.taskId,
    sessionId: ctx.sessionId,
    agentId: "main",
  });

  const taskOf = (ctx: AppToolContext): Task => {
    const task = deps.coreStore.getTask(ctx.taskId);
    if (!task) reject(ctx, "app_data", "identity", "task_missing", "宿主任务不存在，应用数据操作被拒绝");
    return task!;
  };

  /** 批准后单次消费（与工具路由器同一口径：消费前权限版本/任务状态条件更新）。 */
  const consumeApproved = (ctx: AppToolContext, toolName: string): { confirmation: { id: string; permissionVersion: number; params: Record<string, unknown> } } | { error: string } => {
    const confirmation = deps.coreStore
      .listConfirmationsByTask(ctx.taskId)
      .find((c) => c.toolOpId === ctx.hostOpId && c.status === "approved");
    if (!confirmation) return { error: "审批记录缺失或已失效，操作未执行" };
    const consumed = deps.coreStore.withTx(() => {
      const ok = deps.coreStore.consumeApproval({
        confirmationId: confirmation.id,
        expectedPermissionVersion: confirmation.permissionVersion,
        activeStatuses: ["running", "awaiting_confirmation"],
      });
      if (ok) {
        deps.coreStore.appendEvent(
          { type: "task.approval_consumed", taskId: ctx.taskId, confirmationId: confirmation.id, toolOpId: ctx.hostOpId, toolName },
          { taskId: ctx.taskId, sessionId: ctx.sessionId },
        );
      }
      return ok;
    });
    if (!consumed) return { error: "批准已失效（任务结束、权限版本变化或已被消费），操作未执行" };
    return { confirmation };
  };

  const approvalFailureText = (approval: ApprovalOutcome): string =>
    approval.decision === "rejected"
      ? approval.source === "auto_review"
        ? `自动审查拒绝执行该操作：${approval.reviewReason ?? "未给出理由"}`
        : "拥有者拒绝执行该操作"
      : "模式已切换、任务已停止或版本已变化，该审批已失效；如仍需要请重新申请";

  /** 破坏性变更的统一执行路径：预检 → 审批 → 重核 → 单次消费 → 按不可变快照执行。 */
  const runDestructive = async (input: {
    ctx: AppToolContext;
    toolName: string;
    params: Record<string, unknown>;
    scope: Extract<ApprovalScope, { kind: "app_data_change" }>;
    execute: (params: Record<string, unknown>) => string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> => {
    const { ctx, toolName, params, scope, execute } = input;
    // 预检：参数与版本必须合法（审批展示与批准后执行的前提）
    try {
      validateReason(params.reason);
    } catch (err) {
      return fail(err, ctx, toolName);
    }
    const approval = await deps.awaitApproval({
      task: taskOf(ctx),
      hostOpId: ctx.hostOpId,
      toolName,
      params,
      scope,
    });
    if (approval.decision !== "approved") throw new Error(approvalFailureText(approval));
    // 获批后重新核实 main 身份、任务、权限与应用数据版本；任何变化使原请求失效
    checkIdentity(ctx, toolName);
    const fresh = deps.store.getVersions();
    if (fresh.schemaVersion !== scope.schemaVersion || fresh.revision !== scope.revision) {
      throw new Error("应用数据版本在确认期间已变化，原批准失效（未执行）；请重新查询版本后再申请");
    }
    const consumed = consumeApproved(ctx, toolName);
    if ("error" in consumed) throw new Error(consumed.error);
    // 执行参数取自批准记录的不可变快照
    return okText(execute(consumed.confirmation.params));
  };

  // ---------- 各工具 ----------

  const defineTable = defineTool({
    name: "app_data_define_table",
    label: "app_data_define_table",
    description:
      "在 main 的应用数据空间声明一张业务表（表名、字段、索引、关系）。表已存在时报冲突。" +
      "应用数据保存待办、提醒、习惯等结构化记录；偏好、约定、决策、经验请用 memory_save 进入长期记忆。",
    parameters: Type.Object({
      table: Type.String({ description: "表名（[a-z][a-z0-9_]{0,47}，不能用 sqlite_/app_ 前缀）" }),
      fields: Type.Array(
        Type.Object({
          name: Type.String(),
          type: Type.Union([Type.Literal("text"), Type.Literal("integer"), Type.Literal("real"), Type.Literal("boolean"), Type.Literal("json"), Type.Literal("datetime")]),
          nullable: Type.Optional(Type.Boolean({ description: "默认 false（写入必须给值或允许为空）" })),
          references: Type.Optional(Type.String({ description: "关系：同一空间内已登记表的表名（指向其 _id，RESTRICT）" })),
        }),
      ),
      indexes: Type.Optional(
        Type.Array(
          Type.Object({
            name: Type.String(),
            fields: Type.Array(Type.String()),
            unique: Type.Optional(Type.Boolean()),
          }),
        ),
      ),
      expected_schema_version: Type.Number({ description: "预期当前 schema 版本（先 app_data_query mode=schema 获取）" }),
      reason: Type.String({ description: `创建理由（必填，≤${LIMITS.maxReasonBytes} 字节）` }),
    }),
    execute: bindExecute(async (params) => {
      const ctx = requireCtx();
      try {
        checkIdentity(ctx, "app_data_define_table");
        const out = deps.store.defineTable({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) });
        return okText(out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}${out.applied ? "" : "，重复执行返回原结果"}）`);
      } catch (err) {
        return fail(err, ctx, "app_data_define_table");
      }
    }),
  } as any);

  const migrate = defineTool({
    name: "app_data_migrate",
    label: "app_data_migrate",
    description:
      "执行有界结构化迁移（单事务）：add_field（可空）/add_index/drop_index/drop_field/drop_table/rewrite_rows（按明确行 ID 重写）。" +
      "删除表、删除字段、删除唯一索引与批量重写需要拥有者确认；整次调用包含任一此类操作即整次确认后执行。",
    parameters: Type.Object({
      expected_schema_version: Type.Number({ description: "预期当前 schema 版本" }),
      steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: `迁移步骤（≤${LIMITS.maxMigrateSteps} 步）` }),
      reason: Type.String({ description: "迁移理由（必填）" }),
    }),
    execute: bindExecute(async (params) => {
      const ctx = requireCtx();
      try {
        checkIdentity(ctx, "app_data_migrate");
        const analysis = analyzeMigrate(deps.store, params);
        if (!analysis.destructive) {
          const out = deps.store.migrate({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) });
          return okText(out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`);
        }
        return runDestructive({
          ctx,
          toolName: "app_data_migrate",
          params,
          scope: migrateScope(deps.store, ctx, params, analysis),
          execute: (snap) => {
            const out = deps.store.migrate({ ...snap, opId: ctx.hostOpId, ctx: opCtx(ctx) });
            return out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`;
          },
        });
      } catch (err) {
        return fail(err, ctx, "app_data_migrate");
      }
    }),
  } as any);

  const query = defineTool({
    name: "app_data_query",
    label: "app_data_query",
    description:
      "有界查询 main 的应用数据。mode=schema 发现表结构；mode=rows 按主键分页查询业务数据" +
      "（AND 条件限标量比较/空值检查/有限集合匹配，按 _id 排序）；mode=changes 分页查阅审计记录或按操作 ID 核实提交结果。" +
      "预算：默认 50 行/硬上限 100 行/64 KiB，单次最多扫描 1,000 候选行，总时限 2 秒。",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("schema"), Type.Literal("rows"), Type.Literal("changes")]),
      table: Type.Optional(Type.String({ description: "rows/schema 单表：目标表名" })),
      fields: Type.Optional(Type.Array(Type.String(), { description: "rows：投影字段（默认全部业务字段）" })),
      where: Type.Optional(
        Type.Array(
          Type.Object({
            field: Type.String(),
            op: Type.Union([
              Type.Literal("eq"), Type.Literal("ne"), Type.Literal("lt"), Type.Literal("lte"),
              Type.Literal("gt"), Type.Literal("gte"), Type.Literal("is_null"), Type.Literal("not_null"), Type.Literal("in"),
            ]),
            value: Type.Optional(Type.Unknown()),
            values: Type.Optional(Type.Array(Type.Unknown())),
          }),
        ),
      ),
      cursor: Type.Optional(Type.Unknown({ description: "上一页的继续游标（原样回传）" })),
      limit: Type.Optional(Type.Number({ description: "每页行数（默认 50，上限 100）" })),
      op_id: Type.Optional(Type.String({ description: "changes：按宿主操作 ID 核实提交结果" })),
    }),
    execute: bindExecute(async (params) => {
      const ctx = requireCtx();
      try {
        checkIdentity(ctx, "app_data_query");
        const request = validateQueryRequest(params);
        const opts: RunnerOptions = {};
        const stall = deps.queryStallMs?.();
        if (stall) opts.stallMs = stall;
        const result = await deps.runner.run(deps.store.file, request, opts);
        return okText(formatQueryResult(result));
      } catch (err) {
        return fail(err, ctx, "app_data_query");
      }
    }),
  } as any);

  const insert = defineTool({
    name: "app_data_insert",
    label: "app_data_insert",
    description: `按声明的 schema 原子插入记录（单次 ≤${LIMITS.maxRowsPerWrite} 行；非法行整批拒绝）。返回宿主分配的行 ID、行版本与数据库版本。`,
    parameters: Type.Object({
      table: Type.String({ description: "目标表名" }),
      records: Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "记录数组（字段须已声明）" }),
      expected_schema_version: Type.Optional(Type.Number({ description: "预期当前 schema 版本（提供时校验，不一致即冲突）" })),
      reason: Type.String({ description: "插入理由（必填）" }),
    }),
    execute: bindExecute(async (params) => {
      const ctx = requireCtx();
      try {
        checkIdentity(ctx, "app_data_insert");
        const out = deps.store.insert({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) });
        return okText(out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`);
      } catch (err) {
        return fail(err, ctx, "app_data_insert");
      }
    }),
  } as any);

  const rowWrite = (kind: "update" | "delete") =>
    defineTool({
      name: `app_data_${kind}`,
      label: `app_data_${kind}`,
      description:
        (kind === "update" ? "按明确行 ID 与预期行版本更新字段。" : "按明确行 ID 与预期行版本删除行。") +
        "不接受无条件全表写入；单行直接执行，多行进入拥有者确认。",
      parameters: Type.Object({
        table: Type.String({ description: "目标表名" }),
        rows: Type.Array(
          Type.Object({
            id: Type.Number({ description: "行 _id（正整数）" }),
            expected_version: Type.Number({ description: "预期行版本（并发保护）" }),
            ...(kind === "update" ? { set: Type.Record(Type.String(), Type.Unknown(), { description: "字段更新" }) } : {}),
          }),
        ),
        expected_schema_version: Type.Optional(Type.Number({ description: "预期当前 schema 版本（提供时校验，不一致即冲突）" })),
        reason: Type.String({ description: `${kind === "update" ? "更新" : "删除"}理由（必填）` }),
      }),
      execute: bindExecute(async (params) => {
        const ctx = requireCtx();
        const toolName = `app_data_${kind}` as const;
        try {
          checkIdentity(ctx, toolName);
          const rows = Array.isArray(params.rows) ? params.rows : [];
          if (rows.length > 1) {
            return runDestructive({
              ctx,
              toolName,
              params,
              scope: rowWriteScope(deps.store, ctx, kind, params, rows),
              execute: (snap) => {
                const out =
                  kind === "update"
                    ? deps.store.updateRows({ ...snap, opId: ctx.hostOpId, ctx: opCtx(ctx) })
                    : deps.store.deleteRows({ ...snap, opId: ctx.hostOpId, ctx: opCtx(ctx) });
                return out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`;
              },
            });
          }
          const out =
            kind === "update"
              ? deps.store.updateRows({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) })
              : deps.store.deleteRows({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) });
          return okText(out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`);
        } catch (err) {
          return fail(err, ctx, toolName);
        }
      }),
    } as any);

  return [defineTable, migrate, query, insert, rowWrite("update"), rowWrite("delete")] as ToolDefinition[];
}

// ---------- 范围构造与迁移分析 ----------

interface MigrateAnalysis {
  destructive: boolean;
  change: "drop_table" | "drop_field" | "drop_unique_index" | "multi_row_write" | "rewrite_rows";
  tables: string[];
  affected: number;
  before: CatalogTable | null;
  after: Record<string, unknown> | null;
}

function analyzeMigrate(store: AppDataStore, params: Record<string, unknown>): MigrateAnalysis {
  const steps = Array.isArray(params.steps) ? (params.steps as Array<Record<string, unknown>>) : [];
  if (steps.length === 0) throw new AppDataError("invalid_steps", "steps 必须是非空数组");
  if (steps.length > LIMITS.maxMigrateSteps) {
    throw new AppDataError("too_many_steps", `单次迁移最多 ${LIMITS.maxMigrateSteps} 步`);
  }
  const tables = [...new Set(steps.map((s) => String(s.table ?? "")))];
  const before = tables.length === 1 ? store.getTable(tables[0]!) : null;
  let change: MigrateAnalysis["change"] = "rewrite_rows";
  let affected = steps.length;
  let destructive = false;
  for (const step of steps) {
    const op = String(step.op ?? "");
    if (op === "drop_table") {
      destructive = true;
      change = "drop_table";
    } else if (op === "drop_field") {
      destructive = true;
      change = "drop_field";
    } else if (op === "drop_index") {
      // 按步骤自己的表查目录（多表迁移不能用首张表的定义判断）
      const stepTable = store.getTable(String(step.table ?? ""));
      const index = stepTable?.indexes.find((i) => i.name === String(step.name ?? ""));
      if (index?.unique) {
        destructive = true;
        change = "drop_unique_index";
      }
    } else if (op === "rewrite_rows") {
      destructive = true;
      change = "rewrite_rows";
      affected = Array.isArray(step.rows) ? step.rows.length : 0;
    } else if (op !== "add_field" && op !== "add_index") {
      throw new AppDataError("invalid_step", `不支持的迁移操作：${op.slice(0, 32)}`);
    }
  }
  return {
    destructive,
    change,
    tables,
    affected,
    before,
    after: before ? simulateAfter(before, steps) : null,
  };
}

function simulateAfter(table: CatalogTable, steps: Array<Record<string, unknown>>): Record<string, unknown> | null {
  let fields = [...table.fields];
  let indexes = [...table.indexes];
  for (const step of steps) {
    const op = String(step.op ?? "");
    if (op === "add_field") {
      const f = (step.field ?? {}) as Record<string, unknown>;
      fields = [...fields, { name: String(f.name ?? ""), type: String(f.type ?? ""), nullable: true } as CatalogTable["fields"][number]];
    } else if (op === "drop_field") {
      fields = fields.filter((f) => f.name !== String(step.field ?? ""));
    } else if (op === "add_index") {
      indexes = [...indexes, { name: String(step.name ?? ""), fields: Array.isArray(step.fields) ? step.fields.map(String) : [], unique: step.unique === true } as CatalogTable["indexes"][number]];
    } else if (op === "drop_index") {
      indexes = indexes.filter((i) => i.name !== String(step.name ?? ""));
    }
  }
  return { name: table.name, fields, indexes };
}

function scopeBase(ctx: AppToolContext, store: AppDataStore, params: Record<string, unknown>): {
  appDbInstanceId: string;
  taskId: string;
  toolOpId: string;
  schemaVersion: number;
  revision: number;
  paramsSha256: string;
} {
  const versions = store.getVersions();
  return {
    appDbInstanceId: store.getInstanceId(),
    taskId: ctx.taskId,
    toolOpId: ctx.hostOpId,
    schemaVersion: versions.schemaVersion,
    revision: versions.revision,
    paramsSha256: sha256Of(params),
  };
}

function migrateScope(store: AppDataStore, ctx: AppToolContext, params: Record<string, unknown>, analysis: MigrateAnalysis): Extract<ApprovalScope, { kind: "app_data_change" }> {
  return {
    kind: "app_data_change",
    ...scopeBase(ctx, store, params),
    table: analysis.tables.length === 1 ? analysis.tables[0]! : null,
    operation: "migrate",
    change: analysis.change,
    affected: analysis.affected,
    rowIds: [],
    rowVersions: {},
    definitionBefore: analysis.before ? { name: analysis.before.name, fields: analysis.before.fields, indexes: analysis.before.indexes } : null,
    definitionAfter: analysis.after,
  };
}

function rowWriteScope(
  store: AppDataStore,
  ctx: AppToolContext,
  kind: "update" | "delete",
  params: Record<string, unknown>,
  rows: Array<Record<string, unknown>>,
): Extract<ApprovalScope, { kind: "app_data_change" }> {
  const rowIds = rows.map((r) => {
    const id = Number(r.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new AppDataError("invalid_row_id", "行 ID 必须是正整数");
    return id;
  });
  const rowVersions: Record<string, number> = {};
  for (const row of rows) {
    const version = Number(row.expected_version);
    if (!Number.isInteger(version) || version < 0) throw new AppDataError("invalid_version", "expected_version 必须是非负整数");
    rowVersions[String(Number(row.id))] = version;
  }
  return {
    kind: "app_data_change",
    ...scopeBase(ctx, store, params),
    table: String(params.table ?? ""),
    operation: kind,
    change: "multi_row_write",
    affected: rows.length,
    rowIds,
    rowVersions,
    definitionBefore: null,
    definitionAfter: null,
  };
}

function formatQueryResult(result: Record<string, unknown>): string {
  const head = `schema v${result.schema_version} / rev ${result.revision} · ${result.complete ? "完整" : "不完整（达到扫描/结果预算，用 next_cursor 继续）"}`;
  if (result.mode === "rows") {
    const rows = (result.rows as unknown[]) ?? [];
    return [
      `${head} · 扫描 ${result.scanned} 行，返回 ${rows.length} 行`,
      ...rows.map((r) => JSON.stringify(r)),
      result.next_cursor ? `next_cursor=${result.next_cursor}` : "（无更多结果）",
    ].join("\n");
  }
  if (result.mode === "changes") {
    const changes = (result.changes as unknown[]) ?? [];
    return [
      `${head} · 返回 ${changes.length} 条审计`,
      ...changes.map((c) => JSON.stringify(c)),
      result.next_cursor ? `next_cursor=${result.next_cursor}` : "（无更多结果）",
    ].join("\n");
  }
  if (result.table) return `${head}\n${JSON.stringify(result.table)}`;
  const tables = (result.tables as unknown[]) ?? [];
  return [`${head} · ${tables.length} 张表`, ...tables.map((t) => JSON.stringify(t))].join("\n");
}
