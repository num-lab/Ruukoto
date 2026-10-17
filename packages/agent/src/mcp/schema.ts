import { Compile } from "typebox/compile";
import { MCP_LIMITS, type McpRemoteTool } from "./transport.ts";

/** schema 预检：普通对象、根类型 object（MCP 规范）、大小上限、TypeBox 可编译；返回校验器或禁用原因。 */
export function compileMcpSchema(label: string, raw: unknown): { schema: Record<string, unknown>; check: (value: unknown) => boolean } | { disabledReason: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { disabledReason: `${label} 不是普通对象（不支持布尔/数组 schema）` };
  }
  const schema = raw as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") {
    return { disabledReason: `${label} 根类型必须是 object（收到 ${String(schema.type)}）` };
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (schemaBytes > MCP_LIMITS.maxToolSchemaBytes) {
    return { disabledReason: `${label} 超过 ${MCP_LIMITS.maxToolSchemaBytes} 字节上限（${schemaBytes}）` };
  }
  try {
    // 与 pi 参数校验同一能力边界：编译不过即不支持，明确禁用
    const validator: { Check(value: unknown): boolean } = Compile(schema as any) as any;
    return { schema, check: (value) => validator.Check(value) };
  } catch (err) {
    return { disabledReason: `${label} 不受支持（${(err as Error).message.slice(0, 120)}）` };
  }
}

/**
 * 单工具校验（inputSchema 与可选的 outputSchema 同一套预检）；不通过返回禁用原因。
 * outputSchema 钉版为结果校验器：SDK 不做本地输出校验（见 client.callTool），
 * 远端成功应答后由路由器按它校验结构化结果。
 */
export function validateRemoteTool(
  tool: McpRemoteTool,
): { inputSchema: Record<string, unknown>; checkOutput?: (value: unknown) => boolean } | { disabledReason: string } {
  const input = compileMcpSchema("inputSchema", tool.inputSchema ?? { type: "object", properties: {} });
  if ("disabledReason" in input) return input;
  if (tool.outputSchema === undefined) return { inputSchema: input.schema };
  const output = compileMcpSchema("outputSchema", tool.outputSchema);
  if ("disabledReason" in output) return output;
  return { inputSchema: input.schema, checkOutput: output.check };
}
