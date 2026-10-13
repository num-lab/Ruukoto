/**
 * 应用数据有界查询（issue 02）：首版采用主键游标分页，不开放任意 SQL、
 * JOIN、子查询、聚合、正则或全表排序。rows 支持字段选择 + 有界 AND 条件
 * （标量比较、空值检查、有限集合匹配），按内部 _id 排序。
 *
 * 预算（宿主常量，模型不可调大）：
 * - 默认 50 行/硬上限 100 行、结果 64 KiB；候选 1,000 行/1 MiB；
 * - 先按 `_id > cursor` 读固定候选窗口，再在窗口内过滤与投影——少量命中也
 *   不能扫描整表；
 * - 游标绑定表、查询参数摘要和版本；跨页数据变化返回游标冲突，调用方重查；
 * - 请求显式超过限额时拒绝；合法分页耗尽扫描或结果预算时 complete=false，
 *   不把部分结果描述为完整结果。
 *
 * 本模块同时供宿主与只读查询子进程使用：子进程再次校验后执行。
 */

import { createHash } from "node:crypto";
import { AppDataError, LIMITS, type AppDataStore, type CatalogTable, type FieldDef } from "./store.ts";

export const QUERY_LIMITS = {
  defaultRows: 50,
  maxRows: 100,
  maxResultBytes: 64 * 1024,
  maxCandidates: 1000,
  maxCandidateBytes: 1024 * 1024,
  maxInValues: 100,
  /** 单条投影记录上限：超过即拒绝（要求缩小投影），避免空页死循环。 */
  maxRecordBytes: 64 * 1024,
  auditFields: ["opId", "toolName", "taskId", "agentId", "schemaVersion", "revision", "affected", "resultSummary", "createdAt"] as const,
} as const;

const COMPARISON_OPS = ["eq", "ne", "lt", "lte", "gt", "gte", "is_null", "not_null", "in"] as const;
type ComparisonOp = (typeof COMPARISON_OPS)[number];

export interface Condition {
  field: string;
  op: ComparisonOp;
  value?: unknown;
  values?: unknown[];
}

export type QueryRequest =
  | { mode: "schema"; table?: string; cursor?: string; limit?: number }
  | { mode: "rows"; table: string; fields?: string[]; where?: Condition[]; cursor?: string; limit?: number }
  | { mode: "changes"; cursor?: number; limit?: number; opId?: string };

function err(code: string, message: string): never {
  throw new AppDataError(code, message);
}

function expectLimit(raw: unknown): number {
  if (raw === undefined) return QUERY_LIMITS.defaultRows;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) err("invalid_limit", "limit 必须是正整数");
  if (n > QUERY_LIMITS.maxRows) {
    err("limit_exceeded", `limit 超过硬上限 ${QUERY_LIMITS.maxRows}（显式超限即拒绝，请分页）`);
  }
  return n;
}

function validateFieldName(raw: unknown, table: CatalogTable): string {
  const name = typeof raw === "string" ? raw : "";
  if (!table.fields.some((f) => f.name === name)) {
    err("unknown_field", `表 ${table.name} 没有字段：${name.slice(0, 64)}`);
  }
  return name;
}

function validateCondition(raw: unknown, table: CatalogTable): Condition {
  if (typeof raw !== "object" || raw === null) err("invalid_condition", "条件必须是对象");
  const o = raw as Record<string, unknown>;
  const field = validateFieldName(o.field, table);
  const op = String(o.op ?? "") as ComparisonOp;
  if (!(COMPARISON_OPS as readonly string[]).includes(op)) {
    err("invalid_condition", `不支持的条件运算：${String(o.op).slice(0, 32)}`);
  }
  const fieldDef = table.fields.find((f) => f.name === field)!;
  if (op === "is_null" || op === "not_null") return { field, op };
  if (op === "in") {
    if (!Array.isArray(o.values) || o.values.length === 0 || o.values.length > QUERY_LIMITS.maxInValues) {
      err("invalid_condition", `in 条件的 values 须为 1–${QUERY_LIMITS.maxInValues} 个值`);
    }
    for (const value of o.values as unknown[]) validateScalar(fieldDef, value);
    return { field, op, values: o.values as unknown[] };
  }
  validateScalar(fieldDef, o.value);
  return { field, op, value: o.value };
}

function validateScalar(field: FieldDef, value: unknown): void {
  switch (field.type) {
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        err("invalid_condition", `字段 ${field.name} 的条件值需要安全整数`);
      }
      return;
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        err("invalid_condition", `字段 ${field.name} 的条件值需要有限数`);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") err("invalid_condition", `字段 ${field.name} 的条件值需要布尔值`);
      return;
    case "text":
    case "datetime":
      if (typeof value !== "string") err("invalid_condition", `字段 ${field.name} 的条件值需要字符串`);
      return;
    case "json":
      if (value === null || typeof value !== "object") {
        err("invalid_condition", `字段 ${field.name}（json）只支持对象/数组的等值比较`);
      }
      return;
  }
}

function matches(row: Record<string, unknown>, cond: Condition): boolean {
  const actual = row[cond.field];
  switch (cond.op) {
    case "is_null":
      return actual === null || actual === undefined;
    case "not_null":
      return actual !== null && actual !== undefined;
    case "in":
      return (cond.values ?? []).some((v) => valuesEqual(actual, v));
    case "eq":
      return valuesEqual(actual, cond.value);
    case "ne":
      return !valuesEqual(actual, cond.value);
    case "lt":
      return actual !== null && actual !== undefined && (actual as any) < (cond.value as any);
    case "lte":
      return actual !== null && actual !== undefined && (actual as any) <= (cond.value as any);
    case "gt":
      return actual !== null && actual !== undefined && (actual as any) > (cond.value as any);
    case "gte":
      return actual !== null && actual !== undefined && (actual as any) >= (cond.value as any);
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** 查询参数规范化摘要（游标绑定用）。 */
function paramsDigest(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    err("invalid_cursor", "游标无法解析");
  }
  if (typeof parsed !== "object" || parsed === null) err("invalid_cursor", "游标格式非法");
  return parsed as Record<string, unknown>;
}

/** 请求校验（存储边界；子进程再次校验）。 */
export function validateQueryRequest(raw: unknown): QueryRequest {
  if (typeof raw !== "object" || raw === null) err("invalid_request", "查询请求必须是对象");
  const o = raw as Record<string, unknown>;
  const mode = String(o.mode ?? "");
  if (mode === "schema") {
    const req: QueryRequest = { mode };
    if (o.table !== undefined) {
      if (typeof o.table !== "string" || !o.table) err("invalid_request", "table 必须是非空字符串");
      req.table = o.table;
    }
    if (o.cursor !== undefined) {
      if (typeof o.cursor !== "string") err("invalid_cursor", "游标必须是字符串");
      req.cursor = o.cursor;
    }
    req.limit = expectLimit(o.limit);
    return req;
  }
  if (mode === "rows") {
    if (typeof o.table !== "string" || !o.table) err("invalid_request", "rows 查询需要 table");
    const req: QueryRequest = { mode, table: o.table };
    if (o.fields !== undefined) {
      if (!Array.isArray(o.fields) || o.fields.length === 0) err("invalid_request", "fields 必须是非空数组");
      req.fields = o.fields.map((f) => String(f));
    }
    if (o.where !== undefined) {
      if (!Array.isArray(o.where)) err("invalid_request", "where 必须是条件数组");
      if (o.where.length > 16) err("invalid_request", "where 最多 16 个条件");
      req.where = o.where as Condition[];
    }
    if (o.cursor !== undefined) {
      if (typeof o.cursor !== "string") err("invalid_cursor", "游标必须是字符串");
      req.cursor = o.cursor;
    }
    req.limit = expectLimit(o.limit);
    return req;
  }
  if (mode === "changes") {
    const req: QueryRequest = { mode };
    if (o.opId !== undefined) {
      if (typeof o.opId !== "string" || !o.opId) err("invalid_request", "opId 必须是非空字符串");
      req.opId = o.opId;
    }
    if (o.cursor !== undefined) {
      const n = Number(o.cursor);
      if (!Number.isSafeInteger(n) || n < 0) err("invalid_cursor", "changes 游标必须是非负整数（seq）");
      req.cursor = n;
    }
    req.limit = expectLimit(o.limit);
    return req;
  }
  err("invalid_request", `mode 必须是 schema | rows | changes：${mode.slice(0, 32)}`);
}

function checkCursorBinding(cursor: Record<string, unknown>, expected: Record<string, unknown>): void {
  const versions = cursor as { table?: string; digest?: string; sv?: number; rev?: number };
  if (
    versions.table !== expected.table ||
    versions.digest !== expected.digest ||
    versions.sv !== expected.sv ||
    versions.rev !== expected.rev
  ) {
    err(
      "cursor_conflict",
      "游标与当前查询参数或版本不一致（跨页数据可能已变化），请携带原参数重新查询或从首页重查",
    );
  }
}

export interface QueryResponse {
  ok: true;
  mode: string;
  schema_version: number;
  revision: number;
  complete: boolean;
  scanned?: number;
  next_cursor?: string | number | null;
  tables?: unknown[];
  table?: unknown;
  rows?: unknown[];
  changes?: unknown[];
  [key: string]: unknown;
}

/** 版本基座（各 mode 的处理函数补 complete 与数据）。 */
type QueryBase = Pick<QueryResponse, "ok" | "mode" | "schema_version" | "revision">;

/** 执行有界查询（只读；在查询子进程内调用）。版本读取与行扫描在同一只读事务中。 */
export function runQuery(store: AppDataStore, request: QueryRequest): QueryResponse {
  return store.readTx(() => {
    const versions = store.getVersions();
    const base: QueryBase = { ok: true, mode: request.mode, schema_version: versions.schemaVersion, revision: versions.revision };
    if (request.mode === "schema") return runSchema(store, request, base);
    if (request.mode === "rows") return runRows(store, request, base);
    return runChanges(store, request, base);
  });
}

function runSchema(
  store: AppDataStore,
  request: Extract<QueryRequest, { mode: "schema" }>,
  base: QueryBase,
): QueryResponse {
  if (request.table) {
    const table = store.getTable(request.table);
    if (!table) err("table_not_found", `表不存在：${request.table}`);
    return { ...base, complete: true, table: { ...table, rowCount: store.countRows(table.name) } };
  }
  // 表清单分页：名称即游标（目录有界：64 张表）
  const after = request.cursor ?? "";
  const tables = store
    .listTables()
    .filter((t) => t.name > after)
    .slice(0, request.limit ?? QUERY_LIMITS.defaultRows);
  const all = store.listTables();
  return {
    ...base,
    complete: all.length <= tables.length || tables.length < (request.limit ?? QUERY_LIMITS.defaultRows),
    tables: tables.map((t) => ({ name: t.name, fields: t.fields.length, indexes: t.indexes.length })),
    next_cursor: tables.length > 0 && all.length > tables.length ? tables[tables.length - 1]!.name : null,
  };
}

function runRows(
  store: AppDataStore,
  request: Extract<QueryRequest, { mode: "rows" }>,
  base: QueryBase,
): QueryResponse {
  const table = store.getTable(request.table);
  if (!table) err("table_not_found", `表不存在：${request.table}`);
  const projection = request.fields ?? table.fields.map((f) => f.name);
  for (const field of projection) {
    if (!table.fields.some((f) => f.name === field)) err("unknown_field", `表 ${table.name} 没有字段：${field}`);
  }
  const where = (request.where ?? []).map((c) => validateCondition(c, table));
  const digest = paramsDigest({ table: request.table, fields: projection, where });
  const limit = request.limit ?? QUERY_LIMITS.defaultRows;

  let afterId = 0;
  if (request.cursor) {
    const cursor = decodeCursor(request.cursor);
    checkCursorBinding(cursor, { table: request.table, digest, sv: base.schema_version, rev: base.revision });
    const last = Number(cursor.last);
    if (!Number.isSafeInteger(last) || last < 0) err("invalid_cursor", "游标缺少合法位置");
    afterId = last;
  }

  const rows: Array<Record<string, unknown>> = [];
  let resultBytes = 0;
  let scanned = 0;
  let candidateBytes = 0;
  let lastProcessed = afterId;
  let lastReturned = afterId;
  /** 结果预算截断时有已匹配但未返回的行：游标留在最后已返回位置（下页重试）；
   *  其余截断（候选预算/行数上限）推进到最后已处理位置（空页也能继续）。 */
  let pendingMatched = false;
  let budgetExhausted = false;

  // 主键窗口推进（iterate 逐行累计）：少量命中也不能把 SELECT...WHERE 任意
  // 条件 LIMIT 当扫描上限
  for (const candidate of store.scanRows(table, lastProcessed, QUERY_LIMITS.maxCandidates)) {
    const candidateSize = Buffer.byteLength(JSON.stringify(candidate), "utf8");
    if (scanned + 1 > QUERY_LIMITS.maxCandidates || candidateBytes + candidateSize > QUERY_LIMITS.maxCandidateBytes) {
      budgetExhausted = true;
      break; // 候选预算耗尽：不处理该候选，游标不越过它
    }
    scanned += 1;
    lastProcessed = Number(candidate._id);
    candidateBytes += candidateSize;
    if (!where.every((c) => matches(candidate, c))) continue;
    const projected: Record<string, unknown> = { _id: candidate._id, _version: candidate._version };
    for (const field of projection) projected[field] = candidate[field];
    const recordBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
    if (recordBytes > QUERY_LIMITS.maxRecordBytes) {
      err("record_too_large", `单条投影记录超过 ${QUERY_LIMITS.maxRecordBytes} 字节，请缩小投影字段`);
    }
    if (resultBytes + recordBytes > QUERY_LIMITS.maxResultBytes) {
      budgetExhausted = true;
      pendingMatched = true;
      break; // 未返回的匹配行留给下一页（游标留在最后已返回位置，不越过它）
    }
    rows.push(projected);
    resultBytes += recordBytes;
    lastReturned = Number(candidate._id);
    if (rows.length >= limit) {
      budgetExhausted = true; // 还有行未返回：complete=false，分页继续
      break;
    }
  }

  const complete = !budgetExhausted && scanned < QUERY_LIMITS.maxCandidates && candidateBytes <= QUERY_LIMITS.maxCandidateBytes;
  const cursorPos = pendingMatched ? lastReturned : lastProcessed;
  return {
    ...base,
    scanned,
    complete,
    rows,
    next_cursor: complete && rows.length === 0 ? null : encodeCursor({ table: request.table, digest, sv: base.schema_version, rev: base.revision, last: cursorPos }),
  };
}

function runChanges(
  store: AppDataStore,
  request: Extract<QueryRequest, { mode: "changes" }>,
  base: QueryBase,
): QueryResponse {
  if (request.opId) {
    const receipt = store.getReceipt(request.opId);
    if (!receipt) err("op_not_found", `没有该操作的审计回执：${request.opId}`);
    return { ...base, complete: true, changes: [receipt] };
  }
  const after = request.cursor ?? 0;
  const limit = request.limit ?? QUERY_LIMITS.defaultRows;
  const receipts = store.listAudit(after, limit + 1);
  const page = receipts.slice(0, limit);
  let bytes = 0;
  const changes: unknown[] = [];
  for (const receipt of page) {
    const slim: Record<string, unknown> = {};
    for (const field of QUERY_LIMITS.auditFields) slim[field] = receipt[field as keyof typeof receipt];
    const size = Buffer.byteLength(JSON.stringify(slim), "utf8");
    if (changes.length > 0 && bytes + size > QUERY_LIMITS.maxResultBytes) break;
    bytes += size;
    changes.push(slim);
  }
  const hasMore = receipts.length > limit || changes.length < page.length;
  return {
    ...base,
    complete: !hasMore,
    changes,
    next_cursor: hasMore ? (changes.length > 0 ? page[changes.length - 1]!.seq : after) : null,
  };
}

// ---------- 只读查询子进程（宿主侧运行器） ----------

import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** 查询总时限初值（覆盖子进程启动、执行与结果收集）；宿主常量，模型不可调大。 */
export const QUERY_TIMEOUT_MS = 2_000;

const QUERY_CHILD_ENTRY = fileURLToPath(new URL("./query-child.ts", import.meta.url));

export interface RunnerOptions {
  /** 测试挂点：让子进程在收到请求后固定睡眠（仅测试注入；模型侧不可达）。 */
  stallMs?: number;
}

/**
 * 每次查询启动一个固定入口的 Node 子进程，只打开 main.db 的只读连接。
 * 超时/取消后 SIGKILL 并等待退出再返回；关闭 Runtime 时回收在途查询。
 * 不传 owner token、模型凭据或核心数据库句柄（环境只留 PATH 与库路径）。
 * Note: 见 .agents/notes/implemented/architecture/2026-09-23-main-app-data-space.md
 */
export class AppDataQueryRunner {
  private readonly active = new Set<ChildProcess>();
  private disposed = false;

  get inFlight(): number {
    return this.active.size;
  }

  async run(dbFile: string, request: QueryRequest, opts: RunnerOptions = {}): Promise<QueryResponse> {
    if (this.disposed) throw new AppDataError("runner_closed", "后台正在停止，拒绝新查询");
    const child = spawn(process.execPath, ["--import", "tsx", QUERY_CHILD_ENTRY], {
      cwd: path.dirname(QUERY_CHILD_ENTRY),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", APP_DATA_DB_FILE: dbFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.active.add(child);
    try {
      return await this.exchange(child, request, opts);
    } finally {
      this.active.delete(child);
    }
  }

  private exchange(child: ChildProcess, request: QueryRequest, opts: RunnerOptions): Promise<QueryResponse> {
    return new Promise<QueryResponse>((resolve, reject) => {
      let stdout = "";
      let settled = false;
      let timedOut = false;
      const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        void (async () => {
          timedOut = true;
          child.kill("SIGKILL");
          await exited.catch(() => {});
          finish(() => reject(new AppDataError("query_timeout", `查询超过 ${QUERY_TIMEOUT_MS}ms 总预算，子进程已终止`)));
        })();
      }, QUERY_TIMEOUT_MS);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        stdout += chunk;
        const idx = stdout.indexOf("\n");
        if (idx === -1) return;
        const line = stdout.slice(0, idx);
        finish(() => {
          let parsed: { ok?: boolean; code?: string; error?: string } & Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as typeof parsed;
          } catch {
            reject(new AppDataError("bad_response", "查询子进程响应无法解析"));
            return;
          }
          if (parsed.ok === true) {
            resolve(parsed as unknown as QueryResponse);
          } else {
            reject(new AppDataError(parsed.code ?? "query_failed", parsed.error ?? "查询失败"));
          }
        });
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => {
        // 子进程诊断输出：不进任务数据，只留后台 stderr
        process.stderr.write(`[app-data-query] ${chunk}`);
      });
      child.on("error", (err) =>
        finish(() => reject(new AppDataError("spawn_failed", `查询子进程启动失败：${err.message}`))),
      );
      child.on("close", (code, signal) => {
        if (timedOut) return; // 超时路径统一返回 query_timeout（不占结算位）
        finish(() => reject(new AppDataError("child_exited", `查询子进程在响应前退出（code=${code} signal=${signal}）`)));
      });
      const payload = opts.stallMs ? { ...request, __stallMs: opts.stallMs } : request;
      child.stdin!.on("error", () => {
        // 子进程早退时写入可能 EPIPE；结果由 stdio 关闭或超时路径统一给出
      });
      child.stdin!.write(JSON.stringify(payload) + "\n");
      child.stdin!.end();
    });
  }

  /** 关闭 Runtime 时回收在途查询（SIGKILL 并等待退出）。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const children = [...this.active];
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }
    await Promise.all(
      children.map((child) =>
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => child.once("exit", () => resolve())),
      ),
    ).catch(() => {});
    this.active.clear();
  }
}
