import { Type } from "typebox";
import { AppDataError, LIMITS, type AppDataStore, type CatalogTable } from "./store.ts";

export const APP_DATA_PARAMETERS = {
  define_table: Type.Object({
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
  migrate: Type.Object({
      expected_schema_version: Type.Number({ description: "预期当前 schema 版本" }),
      steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: `迁移步骤（≤${LIMITS.maxMigrateSteps} 步）` }),
      reason: Type.String({ description: "迁移理由（必填）" }),
    }),
  query: Type.Object({
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
  insert: Type.Object({
      table: Type.String({ description: "目标表名" }),
      records: Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "记录数组（字段须已声明）" }),
      expected_schema_version: Type.Optional(Type.Number({ description: "预期当前 schema 版本（提供时校验，不一致即冲突）" })),
      reason: Type.String({ description: "插入理由（必填）" }),
    }),
  row_write: (kind: "update" | "delete") => Type.Object({
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
      })
};

export interface MigrateAnalysis {
  destructive: boolean;
  change: "drop_table" | "drop_field" | "drop_unique_index" | "multi_row_write" | "rewrite_rows";
  tables: string[];
  affected: number;
  before: CatalogTable | null;
  after: Record<string, unknown> | null;
}

export function analyzeMigrate(store: AppDataStore, params: Record<string, unknown>): MigrateAnalysis {
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
