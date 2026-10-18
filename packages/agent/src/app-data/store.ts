/**
 * main 应用数据空间（issue 02）：main 角色按需声明的表、字段、索引与数据的
 * 宿主维护存储。独立于核心 ruukoto.db；模型只能经宿主工具操作本空间。
 *
 * - 业务表只由宿主按已校验目录创建；SQL 标识符只能来自目录，值全部绑定参数；
 * - 所有写入在单事务内提交业务/schema 变更、版本递增与追加审计回执；
 *   审计失败、约束失败或磁盘写入失败必须回滚业务变更；
 * - hostOpId 唯一：同操作重复执行先查回执，同参数返回原结果，异参冲突；
 * - 区分存储格式版本（宿主维护）、main 管理的 schema_version 与每次变更递增
 *   的 revision；存储格式过新或损坏时明确停止，不重建、不静默恢复。
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";

/** 宿主维护的存储格式版本（与 main 管理的 schema_version 分开演进）。 */
export const APP_DATA_STORAGE_VERSION = 1;

// ---------- 宿主固定限额（模型不可调大；集中定义） ----------
export const LIMITS = {
  maxTables: 64,
  maxFieldsPerTable: 32,
  maxIndexesPerTable: 8,
  maxFieldsPerIndex: 4,
  maxRowsPerTable: 10_000,
  maxFieldBytes: 16 * 1024,
  maxRowBytes: 32 * 1024,
  maxWriteBytes: 64 * 1024,
  maxRowsPerWrite: 100,
  maxMigrateSteps: 16,
  maxReasonBytes: 1024,
  maxNameLength: 48,
} as const;

export const NAME_RE = /^[a-z][a-z0-9_]{0,47}$/;
export const FIELD_TYPES = ["text", "integer", "real", "boolean", "json", "datetime"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const SQLITE_TYPE: Record<FieldType, string> = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  boolean: "INTEGER",
  json: "TEXT",
  datetime: "TEXT",
};

export interface FieldDef {
  name: string;
  type: FieldType;
  nullable: boolean;
  /** 关系：指向同一空间内已登记表的 _id（启用后固定 RESTRICT）。 */
  references?: string;
}

export interface IndexDef {
  name: string;
  fields: string[];
  unique: boolean;
}

export interface TableDef {
  name: string;
  fields: FieldDef[];
  indexes: IndexDef[];
}

/** 目录行（app_tables）：持久化的业务表定义与版本。 */
export interface CatalogTable {
  name: string;
  fields: FieldDef[];
  indexes: IndexDef[];
  createdRevision: number;
  updatedRevision: number;
}

export interface AuditReceipt {
  seq: number;
  opId: string;
  toolName: string;
  taskId: string;
  sessionId: string;
  agentId: string;
  schemaVersion: number;
  revision: number;
  reason: string;
  operation: Record<string, unknown>;
  /** schema 变更的前后定义（仅 define_table/migrate；数据操作为 null）。 */
  definitions: { before: Record<string, unknown>; after: Record<string, unknown> } | null;
  affected: string;
  resultSummary: string;
  createdAt: string;
}

/** 宿主回执的内容校验，不含自增序号和校验值自身。 */
export function appDataReceiptFingerprint(receipt: Omit<AuditReceipt, "seq">): string {
  const { receiptFingerprint: _fingerprint, ...operation } = receipt.operation;
  return createHash("sha256").update(JSON.stringify([receipt.opId, receipt.toolName, receipt.taskId, receipt.sessionId, receipt.agentId, receipt.schemaVersion, receipt.revision, receipt.reason, operation, receipt.definitions, receipt.affected, receipt.resultSummary, receipt.createdAt])).digest("hex");
}

export class AppDataError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** schema/版本冲突：返回可识别的冲突与当前版本，不自动覆盖。 */
export class AppDataConflictError extends AppDataError {
  readonly current: Record<string, unknown>;
  constructor(code: string, message: string, current: Record<string, unknown>) {
    super(code, message);
    this.current = current;
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

// ---------- 名称与定义校验（存储边界；工具 JSON schema 只是输入提示） ----------

export function validateName(raw: unknown, what: string): string {
  const name = typeof raw === "string" ? raw : "";
  if (!NAME_RE.test(name)) {
    throw new AppDataError("invalid_name", `${what}名称须为 [a-z][a-z0-9_]{0,47}：${name.slice(0, 64)}`);
  }
  if (name.startsWith("sqlite_") || name.startsWith("app_") || name === "_id" || name === "_version") {
    throw new AppDataError("reserved_name", `${what}名称为保留名：${name}`);
  }
  return name;
}

export function quoteIdent(name: string): string {
  return `"${name}"`;
}

export function validateReason(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new AppDataError("reason_required", "所有写入必须带非空 reason");
  }
  const reason = raw.trim();
  if (byteLength(reason) > LIMITS.maxReasonBytes) {
    throw new AppDataError("reason_too_long", `reason 超过 ${LIMITS.maxReasonBytes} 字节`);
  }
  return reason;
}

function expectVersion(raw: unknown, field: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppDataError("invalid_version", `${field} 必须是非负整数`);
  }
  return n;
}

function validateFields(raw: unknown, opts: { forMigration: boolean }): FieldDef[] {
  if (!Array.isArray(raw)) throw new AppDataError("invalid_fields", "fields 必须是数组");
  if (raw.length === 0) throw new AppDataError("invalid_fields", "至少需要一个业务字段");
  if (raw.length > LIMITS.maxFieldsPerTable) {
    throw new AppDataError("too_many_fields", `每表最多 ${LIMITS.maxFieldsPerTable} 个业务字段`);
  }
  const seen = new Set<string>();
  const fields: FieldDef[] = [];
  for (const entry of raw) {
    const o = entry as Record<string, unknown>;
    const name = validateName(o?.name, "字段");
    if (seen.has(name)) throw new AppDataError("duplicate_name", `重复字段名：${name}`);
    seen.add(name);
    const type = String(o?.type ?? "") as FieldType;
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new AppDataError("invalid_field_type", `字段 ${name} 类型无效：${String(o?.type)}`);
    }
    const field: FieldDef = { name, type, nullable: o?.nullable === true };
    if (o?.references !== undefined) {
      const ref = validateName(o.references, "关系目标表");
      if (!opts.forMigration && ref === name) {
        throw new AppDataError("invalid_reference", `字段 ${name} 不能引用自身字段`);
      }
      field.references = ref;
    }
    fields.push(field);
  }
  return fields;
}

function validateIndexes(raw: unknown, fields: FieldDef[]): IndexDef[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppDataError("invalid_indexes", "indexes 必须是数组");
  if (raw.length > LIMITS.maxIndexesPerTable) {
    throw new AppDataError("too_many_indexes", `每表最多 ${LIMITS.maxIndexesPerTable} 个索引`);
  }
  const scalar = new Set(fields.filter((f) => f.type !== "json").map((f) => f.name));
  const seen = new Set<string>();
  const indexes: IndexDef[] = [];
  for (const entry of raw) {
    const o = entry as Record<string, unknown>;
    const name = validateName(o?.name, "索引");
    if (seen.has(name)) throw new AppDataError("duplicate_name", `重复索引名：${name}`);
    seen.add(name);
    if (!Array.isArray(o?.fields) || o.fields.length === 0) {
      throw new AppDataError("invalid_index", `索引 ${name} 至少引用一个字段`);
    }
    if (o.fields.length > LIMITS.maxFieldsPerIndex) {
      throw new AppDataError("too_many_index_fields", `每索引最多 ${LIMITS.maxFieldsPerIndex} 个字段`);
    }
    const idxFields = (o.fields as unknown[]).map((f) => {
      const fieldName = validateName(f, "索引字段");
      if (!scalar.has(fieldName)) {
        throw new AppDataError("invalid_index_field", `索引 ${name} 引用的字段不存在或非标量：${fieldName}`);
      }
      return fieldName;
    });
    indexes.push({ name, fields: idxFields, unique: o?.unique === true });
  }
  return indexes;
}

export function validateTableDef(raw: { table?: unknown; fields?: unknown; indexes?: unknown }): TableDef {
  const name = validateName(raw.table, "表");
  const fields = validateFields(raw.fields, { forMigration: false });
  const indexes = validateIndexes(raw.indexes, fields);
  return { name, fields, indexes };
}

/** 一次 JSON 序列化 byte 检查（UTF-8/JSON 实际字节；超限不执行）。 */
function checkBytes(label: string, value: unknown, cap: number): string {
  const json = JSON.stringify(value);
  const bytes = byteLength(json);
  if (bytes > cap) {
    throw new AppDataError("payload_too_large", `${label} 超过上限（${bytes} > ${cap} 字节）`);
  }
  return json;
}

// ---------- 存储 ----------

const STORAGE_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_tables (
  name TEXT PRIMARY KEY,
  fields TEXT NOT NULL,
  indexes TEXT NOT NULL,
  created_revision INTEGER NOT NULL,
  updated_revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  tool_name TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  operation TEXT NOT NULL,
  definitions TEXT,
  affected TEXT NOT NULL,
  result_summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_audit_seq ON app_audit (seq);
`;

export interface AppDataStoreOptions {
  /** 只读打开（查询子进程）；默认读写。 */
  readOnly?: boolean;
  /** 已绑定库只核实原身份，不创建或补齐缺失记录。 */
  expectedInstanceId?: string;
  /** 首次初始化事务内写入宿主预先登记的身份。 */
  initialInstanceId?: string;
}

export class AppDataStore {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly readOnly: boolean;
  private readonly verifyReceipts: boolean;
  /** 测试专用故障注入：下一次写入抛错（生产代码路径不设置）。 */
  faultNextWrite: Error | null = null;

  constructor(file: string, opts: AppDataStoreOptions = {}) {
    this.file = file;
    this.readOnly = opts.readOnly === true;
    this.verifyReceipts = opts.expectedInstanceId !== undefined;
    if (this.readOnly || opts.expectedInstanceId !== undefined) {
      if (!fs.existsSync(file)) {
        throw new AppDataError("app_data_unavailable", `应用数据库不存在：${file}`);
      }
      this.db = new DatabaseSync(file, { readOnly: this.readOnly });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(file);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = FULL;");
    }
    try {
      if (opts.expectedInstanceId !== undefined) {
        const meta = this.db.prepare("SELECT key, value FROM app_meta").all() as { key: string; value: string }[];
        const value = (key: string) => meta.find(row => row.key === key)?.value;
        if (value("instance_id") !== opts.expectedInstanceId) throw new AppDataError("app_data_identity_changed", "应用库身份不符，已停止能力；请恢复原库后核实原操作");
        if (Number(value("storage_version")) !== APP_DATA_STORAGE_VERSION) throw new AppDataError("storage_version_unsupported", "应用库存储版本不受支持，请保留原库并使用对应程序");
        for (const key of ["schema_version", "revision"]) if (value(key) === undefined || !Number.isSafeInteger(Number(value(key))) || Number(value(key)) < 0) throw new AppDataError("storage_corrupt", "应用库版本损坏，已停止能力；请保留原库");
        this.db.prepare("SELECT name, fields, indexes, created_revision, updated_revision FROM app_tables LIMIT 0").all();
        this.db.prepare("SELECT seq, op_id, tool_name, task_id, session_id, agent_id, schema_version, revision, reason, operation, definitions, affected, result_summary, created_at FROM app_audit LIMIT 0").all();

      }
      if (!this.readOnly) { this.db.exec("PRAGMA journal_mode = WAL;"); this.db.exec("PRAGMA synchronous = FULL;"); }
      this.db.exec("PRAGMA foreign_keys = ON;");
      if (!this.readOnly && opts.expectedInstanceId === undefined) this.initStorage(opts.initialInstanceId);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initStorage(initialInstanceId?: string): void {
    // 区分首次初始化与既有库验证：既有库缺少目录/审计表即损坏——停止能力，
    // 不静默重建（新建空审计表会被误当作"旧操作未提交"的证据）
    const tables = (
      this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((r) => r.name);
    const isNew = !tables.includes("app_meta");
    if (initialInstanceId && isNew && tables.length) throw new AppDataError("storage_corrupt", "首次应用库已有其他结构，未初始化");
    if (!isNew && (!tables.includes("app_tables") || !tables.includes("app_audit"))) {
      throw new AppDataError("storage_corrupt", "应用数据库缺少目录或审计表（损坏），能力停止，不重建");
    }
    let row: { value: string } | undefined;
    try {
      row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'storage_version'").get() as
        | { value: string }
        | undefined;
    } catch {
      row = undefined;
    }
    if (!isNew && !row) {
      throw new AppDataError("storage_corrupt", "应用数据库缺少存储格式版本记录（损坏），能力停止，不重建");
    }
    const version = row ? Number(row.value) : APP_DATA_STORAGE_VERSION;
    if (row && version > APP_DATA_STORAGE_VERSION) {
      throw new AppDataError(
        "storage_version_too_new",
        `应用数据存储格式过新：文件 ${row.value}，程序 ${APP_DATA_STORAGE_VERSION}（需升级程序）`,
      );
    }
    // 存储格式初始化/幂等建表：首次建立或补齐缺失对象；损坏直接抛错（不重建）
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(STORAGE_SQL);
      this.db
        .prepare(
          "INSERT INTO app_meta (key, value) VALUES ('storage_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(APP_DATA_STORAGE_VERSION));
      this.db
        .prepare("INSERT INTO app_meta (key, value) VALUES ('schema_version', '0') ON CONFLICT(key) DO NOTHING")
        .run();
      this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('revision', '0') ON CONFLICT(key) DO NOTHING").run();
      if (initialInstanceId) {
        this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('instance_id', ?) ON CONFLICT(key) DO NOTHING").run(initialInstanceId);
        if (this.getInstanceId() !== initialInstanceId) throw new AppDataError("app_data_identity_changed", "首次应用库身份不符，未接管");
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务可能已回滚
      }
      throw new AppDataError("storage_init_failed", `应用数据存储初始化失败：${(err as Error).message}`);
    }
  }

  /** 应用库稳定实例 ID（首次分配并持久化；登记到核心库 meta 的依据）。 */
  getInstanceId(): string {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'instance_id'").get() as
      | { value: string }
      | undefined;
    if (row) return row.value;
    if (this.readOnly) {
      throw new AppDataError("app_data_unavailable", "应用数据库缺少实例标识（未初始化或已损坏）");
    }
    const id = `appdb_${randomUUID()}`;
    this.db.prepare("INSERT INTO app_meta (key, value) VALUES ('instance_id', ?)").run(id);
    return id;
  }

  /** main 管理的 schema 版本与每次变更递增的 revision。 */
  getVersions(): { schemaVersion: number; revision: number } {
    const get = (key: string): number => {
      const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as { value: string } | undefined;
      if (!row) throw new AppDataError("app_data_unavailable", `应用数据库缺少版本记录（${key}）`);
      return Number(row.value);
    };
    return { schemaVersion: get("schema_version"), revision: get("revision") };
  }

  /** 目录：全部已登记业务表（名称序）。 */
  listTables(): CatalogTable[] {
    const rows = this.db.prepare("SELECT * FROM app_tables ORDER BY name").all() as any[];
    return rows.map((r) => this.rowToCatalog(r));
  }

  getTable(name: string): CatalogTable | null {
    const row = this.db.prepare("SELECT * FROM app_tables WHERE name = ?").get(name) as any;
    return row ? this.rowToCatalog(row) : null;
  }

  private rowToCatalog(row: any): CatalogTable {
    return {
      name: row.name,
      fields: JSON.parse(row.fields) as FieldDef[],
      indexes: JSON.parse(row.indexes) as IndexDef[],
      createdRevision: Number(row.created_revision),
      updatedRevision: Number(row.updated_revision),
    };
  }

  getReceipt(opId: string): AuditReceipt | null {
    const row = this.db.prepare("SELECT * FROM app_audit WHERE op_id = ?").get(opId) as any;
    if (!row && this.verifyReceipts) {
      const audit = this.db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(revision), 0) AS revision FROM app_audit").get() as { n: number; revision: number };
      const versions = this.getVersions();
      if (audit.n !== versions.revision || audit.revision !== versions.revision) throw new AppDataError("receipt_corrupt", "应用库修订与审计记录不符，不能证明原操作未提交");
    }
    return row ? this.rowToReceipt(row) : null;
  }

  hasTaskReceipt(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM app_audit WHERE task_id = ? LIMIT 1").get(taskId);
  }

  /** 审计分页（主键游标；查询预算统一由 query.ts 计算）。 */
  listAudit(afterSeq: number, limit: number): AuditReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM app_audit WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(afterSeq, limit) as any[];
    return rows.map((r) => this.rowToReceipt(r));
  }

  private rowToReceipt(row: any): AuditReceipt {
    return {
      seq: Number(row.seq),
      opId: row.op_id,
      toolName: row.tool_name,
      taskId: row.task_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      schemaVersion: Number(row.schema_version),
      revision: Number(row.revision),
      reason: row.reason,
      operation: JSON.parse(row.operation) as Record<string, unknown>,
      definitions: row.definitions ? (JSON.parse(row.definitions) as AuditReceipt["definitions"]) : null,
      affected: row.affected,
      resultSummary: row.result_summary,
      createdAt: row.created_at,
    };
  }

  /**
   * 按主键窗口逐行读取候选行（查询预算的扫描范围；projection 由调用方执行）。
   * 用 iterate() 逐行产出，不先 .all() 收集——少量命中也不能扫描整表。
   */
  *scanRows(table: CatalogTable, afterId: number, limit: number): Generator<Record<string, unknown>> {
    const cols = ["_id", "_version", ...table.fields.map((f) => f.name)].map(quoteIdent).join(", ");
    const stmt = this.db.prepare(`SELECT ${cols} FROM ${quoteIdent(table.name)} WHERE _id > ? ORDER BY _id LIMIT ?`);
    let n = 0;
    for (const row of stmt.iterate(afterId, limit)) {
      yield this.decodeRow(table, row as Record<string, unknown>);
      if (++n >= limit) break;
    }
  }

  /**
   * 只读事务：单页的版本读取与行扫描放在同一事务中（WAL 下并发写不会使
   * 版本基座与数据不一致）。只用于查询路径。
   */
  readTx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务可能已回滚
      }
      throw err;
    }
  }

  /** 行数（行数上限与查询展示；表名只接受已登记目录）。 */
  countRows(name: string): number {
    const table = this.requireTable(name);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`).get() as { n: number };
    return Number(row.n);
  }

  getRow(table: CatalogTable, id: number): Record<string, unknown> | null {
    const cols = ["_id", "_version", ...table.fields.map((f) => f.name)].map(quoteIdent).join(", ");
    const row = this.db
      .prepare(`SELECT ${cols} FROM ${quoteIdent(table.name)} WHERE _id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.decodeRow(table, row) : null;
  }

  private decodeRow(table: CatalogTable, row: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { _id: Number(row._id), _version: Number(row._version) };
    for (const field of table.fields) {
      const value = row[field.name];
      if (value === null || value === undefined) {
        out[field.name] = null;
        continue;
      }
      switch (field.type) {
        case "boolean":
          out[field.name] = Number(value) !== 0;
          break;
        case "json":
          out[field.name] = JSON.parse(String(value));
          break;
        case "integer":
          out[field.name] = Number(value);
          break;
        case "real":
          out[field.name] = Number(value);
          break;
        default:
          out[field.name] = value;
      }
    }
    return out;
  }

  // ---------- 值编码（严格校验；缺省、空值和类型错误分别处理） ----------

  private encodeValue(field: FieldDef, value: unknown): string | number | null {
    if (value === null || value === undefined) {
      if (!field.nullable) {
        throw new AppDataError("missing_value", `字段 ${field.name} 不可为空且未提供值`);
      }
      return null;
    }
    let encoded: string | number;
    switch (field.type) {
      case "text":
        if (typeof value !== "string") {
          throw new AppDataError("invalid_value", `字段 ${field.name}（text）需要字符串`);
        }
        encoded = value;
        break;
      case "integer":
        if (typeof value !== "number" || !Number.isSafeInteger(value)) {
          throw new AppDataError("invalid_value", `字段 ${field.name}（integer）需要 JavaScript 安全整数`);
        }
        encoded = value;
        break;
      case "real":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new AppDataError("invalid_value", `字段 ${field.name}（real）需要有限浮点数`);
        }
        encoded = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") {
          throw new AppDataError("invalid_value", `字段 ${field.name}（boolean）需要布尔值`);
        }
        encoded = value ? 1 : 0;
        break;
      case "json": {
        let json: string;
        try {
          json = JSON.stringify(value);
        } catch {
          throw new AppDataError("invalid_value", `字段 ${field.name}（json）必须可序列化`);
        }
        if (json === undefined || byteLength(json) > LIMITS.maxFieldBytes) {
          throw new AppDataError("value_too_large", `字段 ${field.name} 的 JSON 超过 ${LIMITS.maxFieldBytes} 字节`);
        }
        if (jsonDepth(value) > 16) {
          throw new AppDataError("value_too_deep", `字段 ${field.name} 的 JSON 嵌套超过 16 层`);
        }
        encoded = json;
        break;
      }
      case "datetime": {
        if (typeof value !== "string") {
          throw new AppDataError("invalid_value", `字段 ${field.name}（datetime）需要 ISO 时间字符串`);
        }
        const ms = Date.parse(value);
        if (Number.isNaN(ms)) {
          throw new AppDataError("invalid_value", `字段 ${field.name}（datetime）不是合法时间：${value.slice(0, 64)}`);
        }
        encoded = new Date(ms).toISOString();
        break;
      }
      default:
        throw new AppDataError("invalid_field_type", `未知字段类型：${field.type}`);
    }
    if (typeof encoded === "string" && byteLength(encoded) > LIMITS.maxFieldBytes) {
      throw new AppDataError("value_too_large", `字段 ${field.name} 超过 ${LIMITS.maxFieldBytes} 字节`);
    }
    return encoded;
  }

  /** 编码一行业务值（未知字段拒绝；缺省可空字段按空值）。 */
  private encodeRecord(table: CatalogTable, record: unknown): Record<string, string | number | null> {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new AppDataError("invalid_record", "每条记录必须是对象");
    }
    const input = record as Record<string, unknown>;
    const known = new Set(table.fields.map((f) => f.name));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) throw new AppDataError("unknown_field", `表 ${table.name} 没有字段：${key}`);
    }
    const out: Record<string, string | number | null> = {};
    for (const field of table.fields) {
      out[field.name] = this.encodeValue(field, input[field.name]);
    }
    return out;
  }

  // ---------- 写入（单事务：业务变更 + 版本 + 审计回执） ----------

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务可能已回滚
      }
      throw err;
    }
  }

  private setMeta(key: string, value: number): void {
    this.db.prepare("UPDATE app_meta SET value = ? WHERE key = ?").run(String(value), key);
  }

  /** 审计回执（同事务；hostOpId 唯一冲突按重复执行处理）。 */
  private appendAudit(entry: {
    opId: string;
    toolName: string;
    ctx: OpContext;
    schemaVersion: number;
    revision: number;
    reason: string;
    operation: Record<string, unknown>;
    definitions?: { before: Record<string, unknown>; after: Record<string, unknown> } | null;
    affected: string;
    resultSummary: string;
  }): void {
    // 测试故障注入点：审计写入失败必须回滚业务变更（tx 整体回滚）
    if (this.faultNextWrite) {
      const err = this.faultNextWrite;
      this.faultNextWrite = null;
      throw err;
    }
    const receipt: Omit<AuditReceipt, "seq"> = {
      opId: entry.opId, toolName: entry.toolName, taskId: entry.ctx.taskId, sessionId: entry.ctx.sessionId, agentId: entry.ctx.agentId,
      schemaVersion: entry.schemaVersion, revision: entry.revision, reason: entry.reason,
      operation: { ...entry.operation, ...(entry.ctx.requestFingerprint ? { requestFingerprint: entry.ctx.requestFingerprint } : {}) },
      definitions: entry.definitions ?? null, affected: entry.affected, resultSummary: entry.resultSummary, createdAt: new Date().toISOString(),
    };
    if (entry.ctx.requestFingerprint) receipt.operation.receiptFingerprint = appDataReceiptFingerprint(receipt);
    this.db.prepare(`INSERT INTO app_audit (op_id, tool_name, task_id, session_id, agent_id, schema_version, revision, reason, operation, definitions, affected, result_summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt.opId, receipt.toolName, receipt.taskId, receipt.sessionId, receipt.agentId, receipt.schemaVersion, receipt.revision, receipt.reason, JSON.stringify(receipt.operation), receipt.definitions ? JSON.stringify(receipt.definitions) : null, receipt.affected, receipt.resultSummary, receipt.createdAt);
  }

  /**
   * 重复执行核实：hostOpId 已有回执时同参数返回原结果（applied=false），
   * 异参返回冲突——不自动覆盖，不在后台重算后重试。
   */
  private replayIfDuplicate(opId: string, operation: Record<string, unknown>, ctx: OpContext): AuditReceipt | null {
    const existing = this.getReceipt(opId);
    if (!existing) return null;
    const { receiptFingerprint, ...recordedOperation } = existing.operation;
    if (ctx.requestFingerprint && receiptFingerprint !== appDataReceiptFingerprint(existing)) throw new AppDataError("receipt_corrupt", "原应用回执内容校验失败，未重放");
    if (JSON.stringify(recordedOperation) !== JSON.stringify({ ...operation, ...(ctx.requestFingerprint ? { requestFingerprint: ctx.requestFingerprint } : {}) })) {
      throw new AppDataConflictError("op_conflict", `操作 ${opId} 已提交且参数不同`, {
        opId,
        revision: existing.revision,
      });
    }
    return existing;
  }

  private requireTable(name: string): CatalogTable {
    const table = this.getTable(name);
    if (!table) throw new AppDataError("table_not_found", `表不存在：${name}`);
    return table;
  }

  private checkRowCap(table: CatalogTable, extra: number): void {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(table.name)}`).get() as { n: number };
    if (Number(row.n) + extra > LIMITS.maxRowsPerTable) {
      throw new AppDataError("too_many_rows", `表 ${table.name} 行数将超过 ${LIMITS.maxRowsPerTable}`);
    }
  }

  private createPhysicalTable(def: TableDef): void {
    const cols: string[] = ["_id INTEGER PRIMARY KEY AUTOINCREMENT", "_version INTEGER NOT NULL DEFAULT 1"];
    for (const field of def.fields) {
      let col = `${quoteIdent(field.name)} ${SQLITE_TYPE[field.type]}`;
      if (!field.nullable) col += " NOT NULL";
      if (field.references) {
        col += ` REFERENCES ${quoteIdent(field.references)}(_id) ON DELETE RESTRICT ON UPDATE RESTRICT`;
      }
      cols.push(col);
    }
    this.db.exec(`CREATE TABLE ${quoteIdent(def.name)} (${cols.join(", ")})`);
    for (const index of def.indexes) {
      this.createPhysicalIndex(def.name, index);
    }
  }

  private createPhysicalIndex(table: string, index: IndexDef): void {
    const unique = index.unique ? "UNIQUE " : "";
    this.db.exec(
      `CREATE ${unique}INDEX ${quoteIdent(index.name)} ON ${quoteIdent(table)} (${index.fields.map(quoteIdent).join(", ")})`,
    );
  }

  /** define_table：声明表/字段/索引/关系；表已存在即冲突，不用 IF NOT EXISTS 掩盖。 */
  defineTable(params: {
    table?: unknown;
    fields?: unknown;
    indexes?: unknown;
    expected_schema_version?: unknown;
    reason?: unknown;
    opId: string;
    ctx: OpContext;
  }): { applied: boolean; schemaVersion: number; revision: number; summary: string } {
    const def = validateTableDef(params);
    const reason = validateReason(params.reason);
    const expected = expectVersion(params.expected_schema_version, "expected_schema_version");
    checkBytes("define_table 参数", params, LIMITS.maxWriteBytes);
    if (this.listTables().length >= LIMITS.maxTables) {
      throw new AppDataError("too_many_tables", `最多 ${LIMITS.maxTables} 张业务表`);
    }
    for (const field of def.fields) {
      if (field.references) this.requireTable(field.references); // 关系只能指向已登记表
    }
    const operation = { op: "define_table", table: def.name, fields: def.fields, indexes: def.indexes };
    return this.tx(() => {
      const replay = this.replayIfDuplicate(params.opId, operation, params.ctx);
      if (replay) {
        return { applied: false, schemaVersion: replay.schemaVersion, revision: replay.revision, summary: replay.resultSummary };
      }
      const versions = this.getVersions();
      if (params.ctx.expectedRevision !== undefined && versions.revision !== params.ctx.expectedRevision) throw new AppDataConflictError("revision_conflict", "应用数据修订已变化，原批准失效；请重新查询", versions);
      if (versions.schemaVersion !== expected) {
        throw new AppDataConflictError("schema_version_conflict", `schema 版本冲突：当前 ${versions.schemaVersion}，请求预期 ${expected}`, versions as unknown as Record<string, unknown>);
      }
      if (this.getTable(def.name)) {
        throw new AppDataConflictError("table_exists", `表已存在：${def.name}（不提供 IF NOT EXISTS 掩盖不同定义）`, {
          schemaVersion: versions.schemaVersion,
        });
      }
      this.createPhysicalTable(def);
      const revision = versions.revision + 1;
      const schemaVersion = versions.schemaVersion + 1;
      this.db
        .prepare("INSERT INTO app_tables (name, fields, indexes, created_revision, updated_revision) VALUES (?, ?, ?, ?, ?)")
        .run(def.name, JSON.stringify(def.fields), JSON.stringify(def.indexes), revision, revision);
      this.setMeta("schema_version", schemaVersion);
      this.setMeta("revision", revision);
      const summary = `已创建表 ${def.name}（${def.fields.length} 字段，${def.indexes.length} 索引）`;
      this.appendAudit({
        opId: params.opId,
        toolName: "app_data_define_table",
        ctx: params.ctx,
        schemaVersion,
        revision,
        reason,
        operation,
        definitions: { before: {}, after: { fields: def.fields, indexes: def.indexes } },
        affected: def.name,
        resultSummary: summary,
      });
      return { applied: true, schemaVersion, revision, summary };
    });
  }

  /** migrate：有界结构化操作列表，单事务完成；版本不一致返回冲突。 */
  migrate(params: {
    expected_schema_version?: unknown;
    steps?: unknown;
    reason?: unknown;
    opId: string;
    ctx: OpContext;
  }): { applied: boolean; schemaVersion: number; revision: number; summary: string } {
    const reason = validateReason(params.reason);
    const expected = expectVersion(params.expected_schema_version, "expected_schema_version");
    checkBytes("migrate 参数", params, LIMITS.maxWriteBytes);
    if (!Array.isArray(params.steps) || params.steps.length === 0) {
      throw new AppDataError("invalid_steps", "steps 必须是非空数组");
    }
    if (params.steps.length > LIMITS.maxMigrateSteps) {
      throw new AppDataError("too_many_steps", `单次迁移最多 ${LIMITS.maxMigrateSteps} 步`);
    }
    const steps = (params.steps as unknown[]).map((s) => this.validateStep(s));
    // schema 变更保留前后定义（审计可还原变更前 schema）
    const touchedTables = [...new Set(steps.map((s) => s.table))];
    const operation = { op: "migrate", steps };
    return this.tx(() => {
      const replay = this.replayIfDuplicate(params.opId, operation as Record<string, unknown>, params.ctx);
      if (replay) {
        return { applied: false, schemaVersion: replay.schemaVersion, revision: replay.revision, summary: replay.resultSummary };
      }
      const versions = this.getVersions();
      if (params.ctx.expectedRevision !== undefined && versions.revision !== params.ctx.expectedRevision) throw new AppDataConflictError("revision_conflict", "应用数据修订已变化，原批准失效；请重新查询", versions);
      if (versions.schemaVersion !== expected) {
        throw new AppDataConflictError("schema_version_conflict", `schema 版本冲突：当前 ${versions.schemaVersion}，请求预期 ${expected}`, versions as unknown as Record<string, unknown>);
      }
      const definitionsBefore: Record<string, unknown> = {};
      for (const name of touchedTables) {
        const table = this.getTable(name);
        if (table) definitionsBefore[name] = { fields: table.fields, indexes: table.indexes };
      }
      const summaries: string[] = [];
      // 一次有实际变更的事务递增一次 revision（不按步递增）
      const revision = versions.revision + 1;
      for (const step of steps) {
        summaries.push(this.applyStep(step, revision));
      }
      const schemaVersion = versions.schemaVersion + 1;
      this.setMeta("schema_version", schemaVersion);
      this.setMeta("revision", revision);
      const definitionsAfter: Record<string, unknown> = {};
      for (const name of touchedTables) {
        const table = this.getTable(name);
        if (table) definitionsAfter[name] = { fields: table.fields, indexes: table.indexes };
      }
      const summary = `迁移完成（${steps.length} 步）：${summaries.join("；")}`;
      this.appendAudit({
        opId: params.opId,
        toolName: "app_data_migrate",
        ctx: params.ctx,
        schemaVersion,
        revision,
        reason,
        operation: operation as Record<string, unknown>,
        definitions: { before: definitionsBefore, after: definitionsAfter },
        affected: `${steps.length} 步`,
        resultSummary: summary,
      });
      return { applied: true, schemaVersion, revision, summary };
    });
  }

  private validateStep(raw: unknown): MigrateStep {
    if (typeof raw !== "object" || raw === null) throw new AppDataError("invalid_step", "迁移步骤必须是对象");
    const o = raw as Record<string, unknown>;
    const op = String(o.op ?? "");
    switch (op) {
      case "add_field": {
        const table = validateName(o.table, "表");
        const fields = validateFields([o.field], { forMigration: true });
        const field = fields[0]!;
        if (!field.nullable) {
          throw new AppDataError("invalid_step", "首版只支持增加可空字段（NOT NULL 需要默认值/回填，不隐式处理）");
        }
        return { op, table, field };
      }
      case "add_index": {
        const table = validateName(o.table, "表");
        const name = validateName(o.name, "索引");
        if (!Array.isArray(o.fields) || o.fields.length === 0) {
          throw new AppDataError("invalid_step", "add_index 需要 fields 数组");
        }
        return {
          op,
          table,
          index: {
            name,
            fields: (o.fields as unknown[]).map((f) => validateName(f, "索引字段")),
            unique: o.unique === true,
          },
        };
      }
      case "drop_index":
        return { op, table: validateName(o.table, "表"), index: validateName(o.name, "索引") };
      case "drop_field":
        return { op, table: validateName(o.table, "表"), field: validateName(o.field, "字段") };
      case "drop_table":
        return { op, table: validateName(o.table, "表") };
      case "rewrite_rows": {
        const table = validateName(o.table, "表");
        if (!Array.isArray(o.rows) || o.rows.length === 0) {
          throw new AppDataError("invalid_step", "rewrite_rows 需要非空 rows 数组");
        }
        if (o.rows.length > LIMITS.maxRowsPerWrite) {
          throw new AppDataError("too_many_rows", `rewrite_rows 单步最多 ${LIMITS.maxRowsPerWrite} 行`);
        }
        return {
          op,
          table,
          rows: (o.rows as unknown[]).map((r) => {
            const row = r as Record<string, unknown>;
            return {
              id: expectRowId(row?.id),
              expected_version: expectVersion(row?.expected_version, "expected_version"),
              set: row?.set as Record<string, unknown>,
            };
          }),
        };
      }
      default:
        throw new AppDataError("invalid_step", `不支持的迁移操作：${op}`);
    }
  }

  private applyStep(step: MigrateStep, revision: number): string {
    switch (step.op) {
      case "add_field": {
        const table = this.requireTable(step.table);
        if (table.fields.some((f) => f.name === step.field.name)) {
          throw new AppDataConflictError("field_exists", `表 ${step.table} 已有字段 ${step.field.name}`, { schemaVersion: this.getVersions().schemaVersion });
        }
        if (table.fields.length + 1 > LIMITS.maxFieldsPerTable) {
          throw new AppDataError("too_many_fields", `每表最多 ${LIMITS.maxFieldsPerTable} 个业务字段`);
        }
        if (step.field.references) this.requireTable(step.field.references);
        let col = `${quoteIdent(step.field.name)} ${SQLITE_TYPE[step.field.type]}`;
        if (step.field.references) {
          col += ` REFERENCES ${quoteIdent(step.field.references)}(_id) ON DELETE RESTRICT ON UPDATE RESTRICT`;
        }
        this.db.exec(`ALTER TABLE ${quoteIdent(step.table)} ADD COLUMN ${col}`);
        const fields = [...table.fields, step.field];
        this.db.prepare("UPDATE app_tables SET fields = ?, updated_revision = ? WHERE name = ?")
          .run(JSON.stringify(fields), revision, step.table);
        return `表 ${step.table} 增加可空字段 ${step.field.name}`;
      }
      case "add_index": {
        const table = this.requireTable(step.table);
        if (table.indexes.some((i) => i.name === step.index.name)) {
          throw new AppDataConflictError("index_exists", `表 ${step.table} 已有索引 ${step.index.name}`, { schemaVersion: this.getVersions().schemaVersion });
        }
        if (table.indexes.length + 1 > LIMITS.maxIndexesPerTable) {
          throw new AppDataError("too_many_indexes", `每表最多 ${LIMITS.maxIndexesPerTable} 个索引`);
        }
        const scalar = new Set(table.fields.filter((f) => f.type !== "json").map((f) => f.name));
        for (const field of step.index.fields) {
          if (!scalar.has(field)) {
            throw new AppDataError("invalid_index_field", `索引 ${step.index.name} 引用的字段不存在或非标量：${field}`);
          }
        }
        // 唯一索引遇重复数据等约束错误：CREATE INDEX 失败 → 整次回滚
        this.createPhysicalIndex(step.table, step.index);
        const indexes = [...table.indexes, step.index];
        this.db.prepare("UPDATE app_tables SET indexes = ?, updated_revision = ? WHERE name = ?")
          .run(JSON.stringify(indexes), revision, step.table);
        return `表 ${step.table} 增加${step.index.unique ? "唯一" : "普通"}索引 ${step.index.name}`;
      }
      case "drop_index": {
        const table = this.requireTable(step.table);
        const index = table.indexes.find((i) => i.name === step.index);
        if (!index) throw new AppDataError("index_not_found", `表 ${step.table} 没有索引 ${step.index}`);
        this.db.exec(`DROP INDEX ${quoteIdent(step.index)}`);
        this.db.prepare("UPDATE app_tables SET indexes = ?, updated_revision = ? WHERE name = ?")
          .run(JSON.stringify(table.indexes.filter((i) => i.name !== step.index)), revision, step.table);
        return `表 ${step.table} 删除索引 ${step.index}`;
      }
      case "drop_field": {
        const table = this.requireTable(step.table);
        const field = table.fields.find((f) => f.name === step.field);
        if (!field) throw new AppDataError("field_not_found", `表 ${step.table} 没有字段 ${step.field}`);
        if (table.fields.length - 1 === 0) {
          throw new AppDataError("invalid_step", `表 ${step.table} 至少要保留一个业务字段`);
        }
        if (table.indexes.some((i) => i.fields.includes(step.field))) {
          throw new AppDataError("field_in_use", `字段 ${step.field} 仍被索引引用，请先删除相关索引`);
        }
        // 参与外键的列：SQLite 拒绝 DROP COLUMN，整次回滚（首版拒绝无法安全处理的迁移）
        this.db.exec(`ALTER TABLE ${quoteIdent(step.table)} DROP COLUMN ${quoteIdent(step.field)}`);
        this.db.prepare("UPDATE app_tables SET fields = ?, updated_revision = ? WHERE name = ?")
          .run(JSON.stringify(table.fields.filter((f) => f.name !== step.field)), revision, step.table);
        return `表 ${step.table} 删除字段 ${step.field}`;
      }
      case "drop_table": {
        const table = this.requireTable(step.table);
        for (const other of this.listTables()) {
          if (other.name !== step.table && other.fields.some((f) => f.references === step.table)) {
            throw new AppDataError("table_in_use", `表 ${step.table} 仍被 ${other.name} 引用，首版拒绝删除`);
          }
        }
        this.db.exec(`DROP TABLE ${quoteIdent(step.table)}`);
        this.db.prepare("DELETE FROM app_tables WHERE name = ?").run(table.name);
        return `删除表 ${step.table}`;
      }
      case "rewrite_rows": {
        const table = this.requireTable(step.table);
        let updated = 0;
        for (const row of step.rows) {
          updated += this.updateOneRow(table, row.id, row.expected_version, row.set);
        }
        return `表 ${step.table} 按行 ID 重写 ${updated} 行`;
      }
    }
  }

  /** insert：按声明 schema 原子插入；返回宿主分配的行 ID、行版本与数据库版本。 */
  insert(params: {
    table?: unknown;
    records?: unknown;
    reason?: unknown;
    expected_schema_version?: unknown;
    opId: string;
    ctx: OpContext;
  }): { applied: boolean; rows: Array<{ id: number; version: number }>; schemaVersion: number; revision: number; summary: string } {
    const reason = validateReason(params.reason);
    checkBytes("insert 参数", params, LIMITS.maxWriteBytes);
    const name = validateName(params.table, "表");
    if (!Array.isArray(params.records) || params.records.length === 0) {
      throw new AppDataError("invalid_records", "records 必须是非空数组");
    }
    if (params.records.length > LIMITS.maxRowsPerWrite) {
      throw new AppDataError("too_many_rows", `单次最多插入 ${LIMITS.maxRowsPerWrite} 行`);
    }
    const table = this.requireTable(name);
    this.checkRowCap(table, params.records.length);
    const encoded = params.records.map((r) => {
      const row = this.encodeRecord(table, r);
      const bytes = byteLength(JSON.stringify(row));
      if (bytes > LIMITS.maxRowBytes) {
        throw new AppDataError("row_too_large", `单行超过 ${LIMITS.maxRowBytes} 字节`);
      }
      return row;
    });
    const operation = { op: "insert", table: name, records: params.records };
    return this.tx(() => {
      const replay = this.replayIfDuplicate(params.opId, operation as Record<string, unknown>, params.ctx);
      if (replay) {
        const ids = (JSON.parse(replay.affected) as Array<{ id: number; version: number }>) ?? [];
        return { applied: false, rows: ids, schemaVersion: replay.schemaVersion, revision: replay.revision, summary: replay.resultSummary };
      }
      const versions = this.getVersions();
      if (params.ctx.expectedRevision !== undefined && versions.revision !== params.ctx.expectedRevision) throw new AppDataConflictError("revision_conflict", "应用数据修订已变化，原批准失效；请重新查询", versions);
      this.checkExpectedSchemaVersion(params.expected_schema_version, versions);
      const revision = versions.revision + 1;
      const cols = table.fields.map((f) => quoteIdent(f.name)).join(", ");
      const stmt = this.db.prepare(
        `INSERT INTO ${quoteIdent(name)} (${cols}) VALUES (${table.fields.map(() => "?").join(", ")})`,
      );
      const rows: Array<{ id: number; version: number }> = [];
      for (const record of encoded) {
        const info = stmt.run(...table.fields.map((f) => record[f.name] as any));
        rows.push({ id: Number(info.lastInsertRowid), version: 1 });
      }
      this.setMeta("revision", revision);
      const summary = `表 ${name} 插入 ${rows.length} 行（id ${rows.map((r) => r.id).join(", ")}）`;
      this.appendAudit({
        opId: params.opId,
        toolName: "app_data_insert",
        ctx: params.ctx,
        schemaVersion: versions.schemaVersion,
        revision,
        reason,
        operation: operation as Record<string, unknown>,
        affected: JSON.stringify(rows),
        resultSummary: summary,
      });
      return { applied: true, rows, schemaVersion: versions.schemaVersion, revision, summary };
    });
  }

  /** 单行更新/删除共用：预期行版本匹配才写；返回受影响行数（0/1）。 */
  private updateOneRow(table: CatalogTable, id: number, expectedVersion: number, set: Record<string, unknown>): number {
    const existing = this.getRow(table, id);
    if (!existing) throw new AppDataError("row_not_found", `表 ${table.name} 没有行 _id=${id}`);
    if (Number(existing._version) !== expectedVersion) {
      throw new AppDataConflictError(
        "row_version_conflict",
        `表 ${table.name} 行 ${id} 版本冲突：当前 ${existing._version}，请求预期 ${expectedVersion}`,
        { _id: id, _version: existing._version },
      );
    }
    if (typeof set !== "object" || set === null || Array.isArray(set) || Object.keys(set).length === 0) {
      throw new AppDataError("invalid_set", "set 必须是非空对象");
    }
    const known = new Set(table.fields.map((f) => f.name));
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [key, value] of Object.entries(set)) {
      if (!known.has(key)) throw new AppDataError("unknown_field", `表 ${table.name} 没有字段：${key}`);
      const field = table.fields.find((f) => f.name === key)!;
      assignments.push(`${quoteIdent(key)} = ?`);
      values.push(this.encodeValue(field, value));
    }
    // 合并后的整行同样受单行上限约束（只校验更新字段会绕过 32 KiB 限制）
    const merged: Record<string, unknown> = {};
    for (const field of table.fields) {
      merged[field.name] = field.name in set ? set[field.name] : existing[field.name];
    }
    if (byteLength(JSON.stringify(merged)) > LIMITS.maxRowBytes) {
      throw new AppDataError("row_too_large", `合并后的整行超过 ${LIMITS.maxRowBytes} 字节`);
    }
    const info = this.db
      .prepare(
        `UPDATE ${quoteIdent(table.name)} SET ${assignments.join(", ")}, _version = _version + 1 WHERE _id = ? AND _version = ?`,
      )
      .run(...values, id, expectedVersion);
    if (Number(info.changes) !== 1) {
      throw new AppDataConflictError("row_version_conflict", `表 ${table.name} 行 ${id} 更新未生效（版本竞争）`, { _id: id });
    }
    return 1;
  }

  private deleteOneRow(table: CatalogTable, id: number, expectedVersion: number): number {
    const existing = this.getRow(table, id);
    if (!existing) throw new AppDataError("row_not_found", `表 ${table.name} 没有行 _id=${id}`);
    if (Number(existing._version) !== expectedVersion) {
      throw new AppDataConflictError(
        "row_version_conflict",
        `表 ${table.name} 行 ${id} 版本冲突：当前 ${existing._version}，请求预期 ${expectedVersion}`,
        { _id: id, _version: existing._version },
      );
    }
    const info = this.db
      .prepare(`DELETE FROM ${quoteIdent(table.name)} WHERE _id = ? AND _version = ?`)
      .run(id, expectedVersion);
    if (Number(info.changes) !== 1) {
      throw new AppDataConflictError("row_version_conflict", `表 ${table.name} 行 ${id} 删除未生效（版本竞争）`, { _id: id });
    }
    return 1;
  }

  private writeRows(params: {
    kind: "update" | "delete";
    table?: unknown;
    rows?: unknown;
    reason?: unknown;
    expected_schema_version?: unknown;
    opId: string;
    ctx: OpContext;
  }): { applied: boolean; updated: number; schemaVersion: number; revision: number; summary: string } {
    const reason = validateReason(params.reason);
    checkBytes(`${params.kind} 参数`, params, LIMITS.maxWriteBytes);
    const name = validateName(params.table, "表");
    if (!Array.isArray(params.rows) || params.rows.length === 0) {
      throw new AppDataError("invalid_rows", "rows 必须是非空数组");
    }
    if (params.rows.length > LIMITS.maxRowsPerWrite) {
      throw new AppDataError("too_many_rows", `单次最多${params.kind === "update" ? "更新" : "删除"} ${LIMITS.maxRowsPerWrite} 行`);
    }
    const table = this.requireTable(name);
    const rows = (params.rows as unknown[]).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        id: expectRowId(o?.id),
        expected_version: expectVersion(o?.expected_version, "expected_version"),
        set: params.kind === "update" ? (o?.set as Record<string, unknown>) : undefined,
      };
    });
    const ids = new Set(rows.map((r) => r.id));
    if (ids.size !== rows.length) throw new AppDataError("duplicate_row", "单次调用内行 ID 重复");
    const operation = { op: params.kind, table: name, rows: params.rows };
    return this.tx(() => {
      const replay = this.replayIfDuplicate(params.opId, operation as Record<string, unknown>, params.ctx);
      if (replay) {
        return { applied: false, updated: Number(replay.affected), schemaVersion: replay.schemaVersion, revision: replay.revision, summary: replay.resultSummary };
      }
      const versions = this.getVersions();
      if (params.ctx.expectedRevision !== undefined && versions.revision !== params.ctx.expectedRevision) throw new AppDataConflictError("revision_conflict", "应用数据修订已变化，原批准失效；请重新查询", versions);
      this.checkExpectedSchemaVersion(params.expected_schema_version, versions);
      const revision = versions.revision + 1;
      let affected = 0;
      for (const row of rows) {
        affected +=
          params.kind === "update"
            ? this.updateOneRow(table, row.id, row.expected_version, row.set!)
            : this.deleteOneRow(table, row.id, row.expected_version);
      }
      this.setMeta("revision", revision);
      const summary = `表 ${name} ${params.kind === "update" ? "更新" : "删除"} ${affected} 行`;
      this.appendAudit({
        opId: params.opId,
        toolName: params.kind === "update" ? "app_data_update" : "app_data_delete",
        ctx: params.ctx,
        schemaVersion: versions.schemaVersion,
        revision,
        reason,
        operation: operation as Record<string, unknown>,
        affected: String(affected),
        resultSummary: summary,
      });
      return { applied: true, updated: affected, schemaVersion: versions.schemaVersion, revision, summary };
    });
  }

  updateRows(params: { table?: unknown; rows?: unknown; reason?: unknown; expected_schema_version?: unknown; opId: string; ctx: OpContext }) {
    return this.writeRows({ ...params, kind: "update" });
  }

  deleteRows(params: { table?: unknown; rows?: unknown; reason?: unknown; expected_schema_version?: unknown; opId: string; ctx: OpContext }) {
    return this.writeRows({ ...params, kind: "delete" });
  }

  /** 提供 expected_schema_version 时在事务内核对（所有写入共用）。 */
  private checkExpectedSchemaVersion(raw: unknown, versions: { schemaVersion: number; revision: number }): void {
    if (raw === undefined) return;
    const expected = expectVersion(raw, "expected_schema_version");
    if (versions.schemaVersion !== expected) {
      throw new AppDataConflictError(
        "schema_version_conflict",
        `schema 版本冲突：当前 ${versions.schemaVersion}，请求预期 ${expected}`,
        versions as unknown as Record<string, unknown>,
      );
    }
  }

  /** 完整性检查（交付验证）：PRAGMA integrity_check 与 foreign_key_check。 */
  integrityCheck(): { ok: boolean; integrity: string[]; foreignKeys: unknown[] } {
    const integrity = (this.db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map(
      (r) => r.integrity_check,
    );
    const foreignKeys = this.db.prepare("PRAGMA foreign_key_check").all() as unknown[];
    return { ok: integrity.length === 1 && integrity[0] === "ok" && foreignKeys.length === 0, integrity, foreignKeys };
  }

  close(): void {
    if (!this.readOnly) {
      try {
        this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch {
        // 只读或已损坏时 checkpoint 可能失败，不阻断关闭
      }
    }
    this.db.close();
  }
}

/** 行 ID：宿主维护的单调不复用整数主键。 */
function expectRowId(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AppDataError("invalid_row_id", "行 ID 必须是正整数");
  }
  return n;
}

/** JSON 嵌套深度（限制对象/数组层级）。 */
function jsonDepth(value: unknown, depth = 0): number {
  if (depth > 16) return depth;
  if (Array.isArray(value)) {
    return value.reduce<number>((max, v) => Math.max(max, jsonDepth(v, depth + 1)), depth + 1);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (max, v) => Math.max(max, jsonDepth(v, depth + 1)),
      depth + 1,
    );
  }
  return depth;
}

/** 宿主注入的操作来源（任务/会话/agent；不接受模型提供的身份）。 */
export interface OpContext {
  taskId: string;
  sessionId: string;
  agentId: string;
  requestFingerprint?: string;
  expectedRevision?: number;
}

type MigrateStep =
  | { op: "add_field"; table: string; field: FieldDef }
  | { op: "add_index"; table: string; index: IndexDef }
  | { op: "drop_index"; table: string; index: string }
  | { op: "drop_field"; table: string; field: string }
  | { op: "drop_table"; table: string }
  | { op: "rewrite_rows"; table: string; rows: Array<{ id: number; expected_version: number; set: Record<string, unknown> }> };
