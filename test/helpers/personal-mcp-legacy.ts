import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { McpOperation } from "../../apps/ruukoto/src/personal-mcp.ts";
import type { PersonalMcpConfig } from "../../apps/ruukoto/src/personal-mcp-config.ts";

function legacyValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(legacyValue);
  if (!value || typeof value !== "object") return value;
  const mapped: Record<string, JsonValue> = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, legacyValue(item)]));
  if (mapped.version === 4 && typeof mapped.generation === "string" && Array.isArray(mapped.services)) {
    mapped.version = 3;
    for (const service of mapped.services) if (service && typeof service === "object" && !Array.isArray(service)) delete service.toolEffects;
  }
  return mapped;
}

/** 构造旧档案夹具；产品恢复从构造完成后的历史开始，下面的 SQL 不属于迁入实现。 */
export async function legacyMcpFixture(directory: string, operations: McpOperation[], requests: { id: string | number; method: string; params?: unknown }[]) {
  const byOperation = new Map(operations.map((value, index) => {
    const request = value.started ? JSON.stringify({ jsonrpc: "2.0", ...requests[index] }) : undefined;
    const response = value.result || value.remoteError ? JSON.stringify({ jsonrpc: "2.0", id: requests[index].id, ...(value.result ? { result: value.result } : { error: value.remoteError }) }) : undefined;
    return [value.operation, { value, evidence: { ...(request ? { request } : {}), ...(response ? { response } : {}) } }];
  }));
  const storage = await openNodeSqliteStorage(path.join(directory, "personal.sqlite"));
  try {
    const documents = await storage.scanDocuments({ scope: { kind: "session" }, at: "current" }, 256, undefined, BACKGROUND_CONTEXT);
    for (const document of documents.items) {
      if (!["ruukoto.mcp", "ruukoto.mcp-config", "ruukoto.configuration-version"].includes(document.kind)) continue;
      const saved = await storage.document(document.id, "current", BACKGROUND_CONTEXT);
      if (!saved) throw new Error("旧夹具文档缺失");
      const value = legacyValue(saved.value) as Record<string, JsonValue>;
      if (document.kind === "ruukoto.mcp" && value.operation && typeof value.operation === "object" && !Array.isArray(value.operation)) {
        const original = byOperation.get(Number(value.operation.operation) as McpOperation["operation"]);
        if (!original) throw new Error("旧夹具操作缺失");
        for (const key of ["recordVersion", "localEffect", "startedEntry", "result", "remoteError"]) delete value.operation[key];
        value.operation.evidence = original.evidence;
      }
      await storage.commit([{ type: "document.change", id: document.id, content: { kind: "base", version: saved.version, value } }], BACKGROUND_CONTEXT);
    }
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  const db = new DatabaseSync(path.join(directory, "personal.sqlite"));
  try {
    const entries = db.prepare("SELECT id, record FROM entries ORDER BY id").all() as { id: number; record: string }[];
    const update = db.prepare("UPDATE entries SET record = ? WHERE id = ?");
    for (const row of entries) {
      const entry = JSON.parse(row.record) as { kind: string; data?: Record<string, JsonValue> };
      if (entry.data) entry.data = legacyValue(entry.data) as Record<string, JsonValue>;
      const original = entry.data && byOperation.get(Number(entry.data.operation) as McpOperation["operation"]);
      if (original && entry.kind === "ruukoto.mcp-admission") for (const key of ["recordVersion", "localEffect"]) delete entry.data![key];
      if (original && entry.kind === "ruukoto.mcp-start") { entry.kind = "ruukoto.mcp-request"; entry.data = { operation: original.value.operation, admission: original.value.admission, request: original.evidence.request! }; }
      if (original && entry.kind === "ruukoto.mcp-result") { entry.kind = "ruukoto.mcp-observation"; delete entry.data!.result; delete entry.data!.remoteError; entry.data!.evidence = original.evidence; }
      update.run(JSON.stringify(entry), row.id);
    }
    const historical = db.prepare("SELECT id, record FROM entries WHERE json_extract(record, '$.kind') LIKE 'ruukoto.mcp-%' ORDER BY id").all() as { id: number; record: string }[];
    return { config: legacyValue(operations[0].config) as PersonalMcpConfig, historical };
  } finally { db.close(); }
}
