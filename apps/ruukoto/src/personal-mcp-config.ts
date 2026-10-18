import { hasPendingPersonalWork } from "./personal-config-idle.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { connectMcpEndpoint, parseMcpEndpoint, MCP_LIMITS, type McpRemoteTool } from "@ruukoto/agent/mcp/transport.ts";
import { validateRemoteTool } from "@ruukoto/agent/mcp/schema.ts";
import { PersonalError } from "./personal-error.ts";
import { PERSONAL_FORMAT, lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

type JsonObject = { [key: string]: JsonValue };
export type PersonalMcpTool = McpRemoteTool & JsonObject;
export type PersonalMcpCredential = { path: string; sha256: string };
export type PersonalMcpService = { id: string; label: string; endpoint: string; credential?: PersonalMcpCredential; tools: PersonalMcpTool[] };
export type PersonalMcpConfig = { version: 1; generation: string; services: PersonalMcpService[] };
type McpTarget = Pick<PersonalMcpService, "id" | "endpoint" | "credential">;
const context = BACKGROUND_CONTEXT;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const validPath = (value: unknown): value is string => text(value, 4096) && path.isAbsolute(value) && path.resolve(value) === value;
const invalid = () => new PersonalError("mcp_config_invalid", "MCP 配置无法核实，已停止；请保留档案并运行 MCP 配置向导。");
const credentialError = () => new PersonalError("mcp_credentials_invalid", "MCP 凭据无法核实，未发送请求；请检查原私有令牌文件并重新配置，不能改为匿名重试。");

export function parsePersonalMcp(value: unknown): PersonalMcpConfig {
  try { return parseConfig(value); } catch (error) {
    if (error instanceof PersonalError) throw error;
    throw invalid();
  }
}

function parseConfig(value: unknown): PersonalMcpConfig {
  if (!object(value) || Object.keys(value).some(key => !["version", "generation", "services"].includes(key)) || value.version !== 1 || !text(value.generation, 128) || !Array.isArray(value.services)) throw invalid();
  const ids = new Set<string>();
  const services = value.services.map((raw): PersonalMcpService => {
    if (!object(raw) || Object.keys(raw).some(key => !["id", "label", "endpoint", "credential", "tools"].includes(key)) || typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.id) || ids.has(raw.id) || !text(raw.label, 128) || !text(raw.endpoint, 4096) || !Array.isArray(raw.tools) || raw.tools.length > MCP_LIMITS.maxToolsPerService) throw invalid();
    ids.add(raw.id);
    try { if (parseMcpEndpoint(raw.endpoint).hash) throw invalid(); } catch { throw invalid(); }
    let credential: PersonalMcpCredential | undefined;
    if (raw.credential !== undefined) {
      if (!object(raw.credential) || Object.keys(raw.credential).some(key => !["path", "sha256"].includes(key)) || !validPath(raw.credential.path) || typeof raw.credential.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.credential.sha256)) throw invalid();
      credential = { path: raw.credential.path, sha256: raw.credential.sha256 };
    }
    const names = new Set<string>();
    const tools = raw.tools.map((tool): PersonalMcpTool => {
      if (!object(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name) || (tool.description !== undefined && (typeof tool.description !== "string" || tool.description.length > MCP_LIMITS.maxToolDescriptionChars)) || (tool.title !== undefined && typeof tool.title !== "string") || !object(tool.inputSchema) || tool.inputSchema.type !== "object") throw invalid();
      if (tool.annotations !== undefined && (!object(tool.annotations) || Object.entries(tool.annotations).some(([key, item]) => key === "title" ? typeof item !== "string" : ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].includes(key) && typeof item !== "boolean"))) throw invalid();
      const remote = JSON.parse(JSON.stringify(tool)) as PersonalMcpTool;
      if ("disabledReason" in validateRemoteTool(remote)) throw invalid();
      names.add(remote.name);
      return structuredClone(remote);
    });
    return { id: raw.id, label: raw.label, endpoint: raw.endpoint, ...(credential ? { credential } : {}), tools };
  });
  return { version: 1, generation: value.generation, services };
}

function privateFile(filename: string, maxBytes: number): Buffer {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid?.() || (before.mode & 0o077) || before.size > maxBytes) throw invalid();
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw invalid();
    const bytes = fs.readFileSync(fd);
    if (bytes.length > maxBytes) throw invalid();
    return bytes;
  } finally { fs.closeSync(fd); }
}

export function readPersonalMcp(profile: PersonalProfileLock): PersonalMcpConfig | undefined {
  const filename = path.join(profile.directory, "mcp.json");
  let value: unknown;
  try {
    if (!fs.lstatSync(filename, { throwIfNoEntry: false })) return;
    value = JSON.parse(privateFile(filename, Number.MAX_SAFE_INTEGER).toString("utf8"));
  } catch (error) {
    throw new PersonalError("mcp_config_invalid", "MCP 配置必须是完整的私有普通文件，已停止；请保留档案并恢复原配置。", { cause: error });
  }
  return parsePersonalMcp(value);
}

function tokenFile(filename: string) {
  try {
    if (!validPath(filename) || fs.realpathSync(filename) !== filename) throw credentialError();
    const bytes = privateFile(filename, 64 * 1024);
    const token = bytes.toString("utf8").trim();
    if (!token || /[^\x21-\x7e]/.test(token)) throw credentialError();
    return { token, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof PersonalError && error.code === "mcp_credentials_invalid") throw error;
    throw credentialError();
  }
}

export function personalMcpCredential(filename: string): PersonalMcpCredential {
  return { path: filename, sha256: tokenFile(filename).sha256 };
}

/** 匿名服务返回空字符串；配置了凭据时逐请求重读，失效会拒绝，调用方不得降级匿名。 */
export async function resolvePersonalMcpToken(service: McpTarget): Promise<string> {
  if (!service.credential) return "";
  const saved = tokenFile(service.credential.path);
  if (saved.sha256 !== service.credential.sha256) throw credentialError();
  return saved.token;
}

/** 返回完整发现结果；允许列表由拥有者选择，连接在返回或失败时关闭。 */
export async function discoverPersonalMcp(service: McpTarget): Promise<PersonalMcpTool[]> {
  const connection = await connectMcpEndpoint({ serviceId: service.id, endpoint: service.endpoint }, service.credential ? { resolveToken: () => resolvePersonalMcpToken(service) } : {});
  try { return JSON.parse(JSON.stringify(await connection.listTools())) as PersonalMcpTool[]; }
  finally { await connection.close(); }
}

async function checkEnablement(profile: PersonalProfileLock) {
  const filename = path.join(profile.directory, "personal.sqlite");
  if (!fs.existsSync(filename)) return;
  const storage = await openNodeSqliteStorage(filename);
  try {
    const format = await storage.findDocument({ kind: "ruukoto.format", scope: { kind: "session" } }, "current", context);
    const saved = format && await storage.document(format.id, "current", context);
    if (!saved || saved.version !== 1 || !isDeepStrictEqual(saved.value, PERSONAL_FORMAT)) throw new PersonalError("extension_version", "个人业务格式无法核实，未保存 MCP 配置；请保留档案并使用对应程序。");
    if (await hasPendingPersonalWork(storage)) throw new PersonalError("mcp_config_pending", "档案仍有未完成输入或工作，未保存 MCP 配置；请先用原配置完成处理，再修改 MCP 配置。");
    let cursor;
    do {
      const page = await storage.scanDocuments({ kind: "ruukoto.mcp", scope: { kind: "session" }, at: "current" }, 256, cursor, context);
      for (const record of page.items) {
        const saved = await storage.document(record.id, "current", context);
        const op = saved?.value.operation;
        if (!saved || saved.version !== 1 || (op !== undefined && !object(op))) throw new PersonalError("mcp_record_invalid", "MCP 原调用无法核实，未保存配置；请保留档案。");
        if (!op) continue;
        if (op.started && (!op.remoteEnded || (op.effect === "effect_unknown" && !op.resolution))) throw new PersonalError("mcp_config_pending", "MCP 原调用效果或远端结束未核实，未保存配置；请先核实原调用，不要换配置重试。");
      }
      cursor = page.next;
    } while (cursor);
  } finally { await storage.close(context); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-mcp.md
export async function savePersonalMcp(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalMcp(value);
  const profile = typeof target === "string" ? lockPersonalProfile(target) : target;
  try {
    const current = readPersonalMcp(profile);
    if (isDeepStrictEqual(current, config)) return;
    if (current?.generation === config.generation) throw new PersonalError("mcp_config_changed", "MCP 配置变化必须使用新代次，未覆盖原配置；请重新运行 MCP 配置向导。");
    for (const service of config.services) await resolvePersonalMcpToken(service);
    try { await checkEnablement(profile); } catch (error) {
      if (error instanceof PersonalError) throw error;
      throw new PersonalError("mcp_config_check_failed", "无法核实档案是否可修改 MCP 配置，未保存；请保留档案并检查存储。", { cause: error });
    }
    const temporary = path.join(profile.directory, "mcp.json.tmp");
    try {
      if (fs.lstatSync(temporary, { throwIfNoEntry: false })) privateFile(temporary, Number.MAX_SAFE_INTEGER);
      const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw invalid();
        fs.ftruncateSync(fd);
        fs.writeFileSync(fd, JSON.stringify(config) + "\n");
        fs.fsyncSync(fd);
      }
      finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(profile.directory, "mcp.json"));
    } catch (error) {
      throw new PersonalError("mcp_config_write_failed", "MCP 配置未能保存；请保留档案并检查磁盘，再查看当前配置。", { cause: error });
    }
  } finally { if (typeof target === "string") profile.release(); }
}
