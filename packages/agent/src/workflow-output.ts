/** 工作流结果使用有界的基础 JSON Schema；校验不执行正则或外部引用。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md
 */
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import { WorkflowError } from "@ruukoto/core/workflow.ts";
import { isRecord } from "./script-worker/protocol.ts";

const KEYS = new Set(["type", "properties", "required", "items", "additionalProperties", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "title", "description"]);

export function compileWorkflowOutput(raw: unknown): (value: unknown) => boolean {
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (!isRecord(value) || depth > 16 || ++nodes > 256 || Object.keys(value).some(key => !KEYS.has(key))) throw new WorkflowError("invalid_output_schema");
    if (value.type !== undefined) {
      const types = Array.isArray(value.type) ? value.type : [value.type];
      if (types.length === 0 || types.some(type => typeof type !== "string" || !["object", "array", "string", "number", "integer", "boolean", "null"].includes(type))) throw new WorkflowError("invalid_output_schema");
    }
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(item => typeof item !== "string"))) throw new WorkflowError("invalid_output_schema");
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) throw new WorkflowError("invalid_output_schema");
    for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
      if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new WorkflowError("invalid_output_schema");
    }
    for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new WorkflowError("invalid_output_schema");
    }
    if (["title", "description"].some(key => value[key] !== undefined && typeof value[key] !== "string")) throw new WorkflowError("invalid_output_schema");
    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) throw new WorkflowError("invalid_output_schema");
      for (const property of Object.values(value.properties)) visit(property, depth + 1);
    }
    if (value.items !== undefined && typeof value.items !== "boolean") visit(value.items, depth + 1);
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") visit(value.additionalProperties, depth + 1);
  };
  try {
    if (Buffer.byteLength(JSON.stringify(raw) ?? "") > 16 * 1024) throw new WorkflowError("invalid_output_schema");
    visit(raw, 0);
    const check = Compile(raw as TSchema);
    return value => check.Check(value);
  } catch (cause) { throw new WorkflowError("invalid_output_schema", { cause }); }
}
