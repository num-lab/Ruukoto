import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parsePersonalTools, type PersonalToolsConfig } from "../../apps/ruukoto/src/personal-tools-config.ts";
import type { PersonalModelConfig } from "../../apps/ruukoto/src/personal-model.ts";

export type PersonalFileIoLegacyCase = "completed-read" | "completed-write" | "pending-read" | "pending-write";
export type PersonalFileIoLegacyRestore = { directory: string; workspace: string; target: string; tools: PersonalToolsConfig; config: PersonalModelConfig };

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type FixtureCell = string | number | null | { blob: string };
type FixtureColumn = { cid: number; name: string; type: string; notnull: number; dflt_value: string | number | null; pk: number };
type FixtureTable = { columns: FixtureColumn[]; rows: Array<Record<string, FixtureCell>> };
type FixtureSchemaRow = { name: string; sql: string };
type FixtureFile = { type: "sqlite"; schema: FixtureSchemaRow[]; tables: Record<string, FixtureTable> } | { type: "text"; text: string } | { type: "blob"; blob: string };
type FixtureMeta = { baseline: string; operation: string; provenance: string; captured: string; node: string; platform: string; apiKeyEnv: string; substitutions: Record<string, string> };
type Fixture = { format: 1; meta: FixtureMeta; files: Record<string, FixtureFile> };
type SnapshotData = { config: JsonValue; identity: JsonValue; library: JsonValue; version: JsonValue };
type EntryRecord = { kind: string; data: SnapshotData };

const isBlobCell = (value: FixtureCell): value is { blob: string } => typeof value === "object" && value !== null && typeof (value as { blob: unknown }).blob === "string";
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const parseContainer = (value: string): JsonValue | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try { const parsed: unknown = JSON.parse(value); return parsed !== null && typeof parsed === "object" ? parsed as JsonValue : undefined; } catch { return undefined; }
};

export async function restorePersonalFileIoLegacy(caseName: PersonalFileIoLegacyCase, root: string): Promise<PersonalFileIoLegacyRestore> {
  const directory = path.join(root, "profile"), workspace = path.join(root, "workspace"), skillsParent = path.join(root, "skills"), skillsChild = path.join(skillsParent, "skills"), target = path.join(workspace, "legacy");
  const fixture = JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../fixtures/personal-file-io-legacy/${caseName}.json`, import.meta.url)), "utf8")) as Fixture;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(skillsChild, { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, caseName === "completed-write" ? "legacy-write" : "x", { flag: "wx", mode: 0o600 });
  const artifacts: Array<{ dev: number; ino: number }> = [];
  for (const [name, file] of Object.entries(fixture.files)) {
    if (file.type === "sqlite") continue;
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, file.type === "text" ? file.text : Buffer.from(file.blob, "base64"), { flag: "wx", mode: 0o600 });
    if (name.startsWith("artifacts/")) { const stat = fs.statSync(filename); artifacts.push({ dev: stat.dev, ino: stat.ino }); }
  }
  if (artifacts.length > 1) throw new Error(`file-io legacy fixture ${caseName} holds ${artifacts.length} artifact identities, expected at most one fixed class`);
  const statWorkspace = fs.statSync(workspace), statTarget = fs.statSync(target), statSkills = fs.statSync(skillsChild), artifact = artifacts[0];
  const replacements = new Map<string, string | number>([
    ["@@PROFILE@@", directory],
    ["@@WORKSPACE@@", workspace],
    ["@@MODEL_URL@@", "http://127.0.0.1:1"],
    ["@@SKILLS_DIR@@", skillsParent],
    ["@@WORKSPACE_DEV@@", statWorkspace.dev],
    ["@@WORKSPACE_INO@@", statWorkspace.ino],
    ["@@TARGET_DEV@@", statTarget.dev],
    ["@@TARGET_INO@@", statTarget.ino],
    ["@@SKILLS_DEV@@", statSkills.dev],
    ["@@SKILLS_INO@@", statSkills.ino],
  ]);
  if (artifact) { replacements.set("@@ARTIFACT_DEV@@", artifact.dev); replacements.set("@@ARTIFACT_INO@@", artifact.ino); }
  const substitute = (value: JsonValue): JsonValue => {
    if (typeof value === "string") {
      const direct = replacements.get(value);
      if (direct !== undefined) return direct;
      const container = parseContainer(value);
      if (container !== undefined) return JSON.stringify(substitute(container));
      let out = value;
      for (const [token, replacement] of replacements) out = out.split(token).join(String(replacement));
      return out;
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value !== null && typeof value === "object") { const out: Record<string, JsonValue> = {}; for (const [key, item] of Object.entries(value)) out[key] = substitute(item); return out; }
    return value;
  };
  const substituted: Record<string, { schema: FixtureSchemaRow[]; tables: Record<string, FixtureTable> }> = {};
  for (const [name, file] of Object.entries(fixture.files)) {
    if (file.type !== "sqlite") continue;
    const tables: Record<string, FixtureTable> = {};
    for (const [tableName, table] of Object.entries(file.tables)) tables[tableName] = { columns: table.columns, rows: table.rows.map(row => substitute(row as JsonValue) as Record<string, FixtureCell>) };
    substituted[name] = { schema: file.schema, tables };
  }
  const hashes = new Map<string, string>();
  for (const row of substituted["personal.sqlite"]?.tables["entries"]?.rows ?? []) {
    const record = row["record"];
    if (typeof record !== "string") continue;
    const parsed = parseContainer(record) as EntryRecord | undefined, version = parsed?.data?.version;
    if (parsed?.kind !== "ruukoto.skills-snapshot" || typeof version !== "string") continue;
    const data = parsed.data;
    hashes.set(version, createHash("sha256").update(JSON.stringify({ config: data.config, identity: data.identity, library: data.library })).digest("hex"));
  }
  const rehash = (value: JsonValue): JsonValue => {
    if (typeof value === "string") {
      const direct = hashes.get(value);
      if (direct !== undefined) return direct;
      const container = parseContainer(value);
      if (container !== undefined) return JSON.stringify(rehash(container));
      return value;
    }
    if (Array.isArray(value)) return value.map(rehash);
    if (value !== null && typeof value === "object") { const out: Record<string, JsonValue> = {}; for (const [key, item] of Object.entries(value)) out[key] = rehash(item); return out; }
    return value;
  };
  for (const file of Object.values(substituted)) for (const table of Object.values(file.tables)) table.rows = table.rows.map(row => rehash(row as JsonValue) as Record<string, FixtureCell>);
  for (const [name, file] of Object.entries(substituted)) {
    const filename = path.join(directory, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(filename);
    try {
      db.exec("BEGIN");
      for (const statement of file.schema) db.exec(statement.sql);
      for (const [tableName, table] of Object.entries(file.tables)) {
        const columns = table.columns.map(column => column.name);
        const insert = db.prepare(`INSERT INTO ${quote(tableName)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
        for (const row of table.rows) insert.run(...columns.map(column => {
          if (!(column in row)) throw new Error(`file-io legacy fixture ${caseName} row missing cell ${tableName}.${column}`);
          const value = row[column];
          return value === null ? null : isBlobCell(value) ? Buffer.from(value.blob, "base64") : value;
        }));
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
    fs.chmodSync(filename, 0o600);
  }
  const config: PersonalModelConfig = { api: "openai-completions", baseUrl: "http://127.0.0.1:1", modelId: "mock-model", apiKeyEnv: "RUUKOTO_FILEIO_TEST_KEY", contextWindow: 128000, maxTokens: 8192 };
  const tools = parsePersonalTools({ version: 1, generation: "file-io-legacy", workspace, identity: { dev: statWorkspace.dev, ino: statWorkspace.ino }, credentials: [] });
  return { directory, workspace, target, tools, config };
}
