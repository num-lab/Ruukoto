/**
 * main 应用数据宿主工具（issue 02）：define_table / migrate / query / insert /
 * update / delete。模型侧统一 `app_data_` 前缀，避免与其他工具重名。
 *
 * - 身份由宿主注入（当前任务 → 会话 → 个人助手宿主绑定）；执行入口每次重新核实
 *   宿主任务、会话、项目与 main 或独立定时会话身份，工具参数不接受 agent/project/路径；
 * - 所有写入必须带非空 reason（≤1 KiB）；schema 校验在存储边界执行；
 * - 非破坏性变更自动执行；删除表/字段/唯一索引、多行写与批量重写进入
 *   审批闸门（ApprovalGate），完全访问免审批，受限模式单次消费批准；
 *   授权事务内复核身份与版本，执行参数取自不可变授权快照；
 * - 应用数据保存待办/提醒/习惯等结构化记录；偏好、约定、决策、经验仍进入
 *   长期记忆（MemoryStore），应用记录不自动提升为长期记忆或控制指令；
 * - 身份不符、校验失败、预算超限和超时留下可识别的 app_data.rejected 事件。
 */

import { APP_DATA_PARAMETERS, analyzeMigrate, type MigrateAnalysis } from "./contract.ts";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import type { Store } from "@ruukoto/core/store.ts";
import type { FamilyCheck } from "../tool-op-ledger.ts";
import type { ApprovalScope, Task } from "@ruukoto/core/types.ts";
import type { ApprovalGate } from "../approval-gate.ts";
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

import { hostCallFor } from "../host-tools.ts";
import type { HostCallBinder, HostToolContext } from "../host-tools.ts";
import type { HostToolFamily, HostToolLedger } from "../host-tool-families.ts";

/** 应用数据工具的执行上下文（身份由宿主注入，不从工具参数取得）。 */
export type AppToolContext = HostToolContext;

export interface AppDataToolsDeps {
  store: AppDataStore;
  runner: AppDataQueryRunner;
  /** 核心库：app_data.rejected 事件与宿主任务读取（审批消费归审批闸门）。 */
  coreStore: Store;
  /** 当前调用上下文（宿主注入；绑定一次工具调用）。 */
  taskContext(): AppToolContext | null;
  /** 绑定一次工具调用的独立句柄；execute 在 finally 中释放。 */
  bindCall?: HostCallBinder;
  /** 执行入口每次重新核实宿主任务/会话/项目与个人助手宿主绑定；null=通过。 */
  verifyMain(ctx: AppToolContext): string | null;
  /** 审批闸门（窄回调；不向模型暴露控制面）。 */
  requestApproval: ApprovalGate["request"];
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

export const APP_DATA_LEDGER: HostToolLedger = {
  names: APP_DATA_TOOL_NAMES,
  ruleFor: (name) => name === "app_data_query" ? "no_effect" : { family: "app_data" },
};

export function createAppDataFamily(config: Omit<AppDataToolsDeps, "store" | "taskContext" | "bindCall" | "verifyMain" | "requestApproval"> & { store: AppDataStore | null; writeVerdict: (hostOpId: string) => "committed" | "not_committed" | "unverifiable" }): HostToolFamily {
  return {
    category: "app_data",
    names: config.store ? APP_DATA_TOOL_NAMES : [],
    build: (runtime) => config.store ? createAppDataTools({
      ...config,
      store: config.store,
      ...runtime.call,
      verifyMain: runtime.identity.verifyMain,
      requestApproval: runtime.approval.request,
    }) : [],
    ledger: { ...APP_DATA_LEDGER, familyCheck: appDataOpCheck(config.writeVerdict) },
  };
}

/**
 * 工具操作账本的族核实（issue 02）：写操作按应用库回执核实；应用库丢失/损坏即无法核实。
 * Note: 见 .agents/notes/implemented/architecture/2026-09-23-main-app-data-space.md
 */
export function appDataOpCheck(writeVerdict: (hostOpId: string) => "committed" | "not_committed" | "unverifiable"): FamilyCheck {
  return {
    verify: (op) => writeVerdict(op.id),
    committed: (when) => `已提交：应用库存在该操作回执（${when}已生效）`,
    notCommitted: (when) => `已知未提交：应用库无该操作回执（${when}未生效）`,
  };
}

function okText(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text }] };
}

function sha256Of(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createAppDataTools(deps: AppDataToolsDeps): ToolDefinition[] {
  const requireCtx = (ctx: AppToolContext | null): AppToolContext => {
    if (!ctx) throw new Error("工具调用缺少宿主任务上下文");
    return ctx;
  };
  const bindExecute = <P extends Record<string, unknown>>(
    fn: (params: P, ctx: AppToolContext, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }> }>,
  ) => {
    return async (sdkCallId: string, params: P, signal?: AbortSignal) => {
      const call = hostCallFor(deps.bindCall, deps.taskContext, sdkCallId);
      try {
        return await fn(params, requireCtx(call.context), signal);
      } finally {
        call.release();
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
    agentId: deps.coreStore.getTask(ctx.taskId)!.subAgentId ?? (deps.coreStore.getSessionIdentity(ctx.sessionId)!.kind === "scheduled" ? "scheduled" : "main"),
  });

  const taskOf = (ctx: AppToolContext): Task => {
    const task = deps.coreStore.getTask(ctx.taskId);
    if (!task) reject(ctx, "app_data", "identity", "task_missing", "宿主任务不存在，应用数据操作被拒绝");
    return task!;
  };

  /** 破坏性变更统一预检、核实授权与版本，再按固定快照执行；完全访问免审批。 */
  const runDestructive = async (input: {
    ctx: AppToolContext;
    toolName: string;
    params: Record<string, unknown>;
    scope: Extract<ApprovalScope, { kind: "app_data_change" }>;
    signal?: AbortSignal;
    execute: (params: Record<string, unknown>) => string;
  }): Promise<{ content: Array<{ type: string; text: string }> }> => {
    const { ctx, toolName, params, scope, execute } = input;
    // 预检：参数与版本必须合法（审批展示与批准后执行的前提）
    try {
      validateReason(params.reason);
    } catch (err) {
      return fail(err, ctx, toolName);
    }
    let identityProblem: string | null = null;
    const approval = await deps.requestApproval({
      task: taskOf(ctx),
      hostOpId: ctx.hostOpId,
      toolName,
      params,
      scope,
      signal: input.signal,
      // 授权前重新核实宿主绑定与应用数据版本（应用库不在核心事务内，写入时再按期望版本核对）
      recheck: () => {
        identityProblem = deps.verifyMain(ctx);
        if (identityProblem) return identityProblem;
        const fresh = deps.store.getVersions();
        return fresh.schemaVersion !== scope.schemaVersion || fresh.revision !== scope.revision
          ? "应用数据版本在执行前已变化，本次授权失效（未执行）；请重新查询版本后执行"
          : null;
      },
    });
    if (!approval.approved) {
      // 身份不符照常留 app_data.rejected（闸门事务外写入）
      if (identityProblem) reject(ctx, toolName, "identity", "identity_mismatch", identityProblem);
      throw new Error(approval.text);
    }
    return okText(execute(approval.params));
  };

  // ---------- 各工具 ----------

  const defineTable = defineTool({
    name: "app_data_define_table",
    label: "app_data_define_table",
    description:
      "在 main 的应用数据空间声明一张业务表（表名、字段、索引、关系）。表已存在时报冲突。" +
      "应用数据保存待办、提醒、习惯等结构化记录；偏好、约定、决策、经验请用 memory_save 进入长期记忆。",
    parameters: APP_DATA_PARAMETERS.define_table,
    execute: bindExecute(async (params, ctx) => {
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
      "删除表、删除字段、删除唯一索引与批量重写在受限模式下需要拥有者确认；完全访问免审批，仍校验身份与版本。",
    parameters: APP_DATA_PARAMETERS.migrate,
    execute: bindExecute(async (params, ctx, signal) => {
      try {
        checkIdentity(ctx, "app_data_migrate");
        const analysis = analyzeMigrate(deps.store, params);
        if (!analysis.destructive) {
          const out = deps.store.migrate({ ...params, opId: ctx.hostOpId, ctx: opCtx(ctx) });
          return okText(out.summary + `（schema v${out.schemaVersion}，rev ${out.revision}）`);
        }
        return await runDestructive({
          ctx,
          toolName: "app_data_migrate",
          params,
          scope: migrateScope(deps.store, ctx, params, analysis),
          signal,
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
    parameters: APP_DATA_PARAMETERS.query,
    execute: bindExecute(async (params, ctx) => {
      try {
        checkIdentity(ctx, "app_data_query");
        // 工具契约的 op_id 映射到内部请求的 opId（直接透传会丢失过滤条件）
        const raw = { ...(params as Record<string, unknown>) };
        if (raw.op_id !== undefined && raw.opId === undefined) raw.opId = raw.op_id;
        delete raw.op_id;
        const request = validateQueryRequest(raw);
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
    parameters: APP_DATA_PARAMETERS.insert,
    execute: bindExecute(async (params, ctx) => {
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
        "不接受无条件全表写入；单行直接执行，多行在受限模式下进入拥有者确认，完全访问免审批。",
      parameters: APP_DATA_PARAMETERS.row_write(kind),
      execute: bindExecute(async (params, ctx, signal) => {
        const toolName = `app_data_${kind}` as const;
        try {
          checkIdentity(ctx, toolName);
          const rows = Array.isArray(params.rows) ? params.rows : [];
          if (rows.length > 1) {
            return await runDestructive({
              ctx,
              toolName,
              params,
              scope: rowWriteScope(deps.store, ctx, kind, params, rows),
              signal,
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
  return [
    `${head} · ${tables.length} 张表`,
    ...tables.map((t) => JSON.stringify(t)),
    result.next_cursor ? `next_cursor=${result.next_cursor}` : "（无更多结果）",
  ].join("\n");
}
