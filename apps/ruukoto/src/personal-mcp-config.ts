import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { JsonValue } from "@earendil-works/chord";
import { connectMcpEndpoint, connectMcpStdio, parseMcpEndpoint, type McpRemoteTool } from "@ruukoto/agent/mcp/transport.ts";
import { cuaProgram, parseCuaConfig, type CuaConfig } from "@ruukoto/agent/mcp/cua.ts";
import { validateRemoteTool } from "@ruukoto/agent/mcp/schema.ts";
import { PersonalError } from "./personal-error.ts";
import { lockPersonalProfile, type PersonalProfileLock } from "./personal-profile.ts";

type JsonObject = { [key: string]: JsonValue };
export type PersonalMcpTool = McpRemoteTool & JsonObject;
export type PersonalMcpCredential = { path: string; sha256: string } | { path: string; tokenSha256: string };
export type PersonalMcpToolEffect = "read" | "write" | "unknown";
type PersonalCuaConfig = { [K in keyof Extract<CuaConfig, { kind: "cua-linux" }>]: Extract<CuaConfig, { kind: "cua-linux" }>[K] };
export type PersonalMcpService = { id: string; label: string; tools: PersonalMcpTool[]; toolEffects?: Record<string, PersonalMcpToolEffect>; enabled?: boolean; cua?: PersonalCuaConfig; endpoint?: string; credential?: PersonalMcpCredential };
export type PersonalMcpConfig = { version: 1 | 2 | 3 | 4; generation: string; services: PersonalMcpService[] };
type McpTarget = Pick<PersonalMcpService, "id" | "endpoint" | "credential" | "cua">;
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
  if (!object(value) || Object.keys(value).some(key => !["version", "generation", "services"].includes(key)) || ![1, 2, 3, 4].includes(Number(value.version)) || !text(value.generation, 128) || !Array.isArray(value.services)) throw invalid();
  const ids = new Set<string>();
  const services = value.services.map((raw): PersonalMcpService => {
    if (!object(raw) || Object.keys(raw).some(key => !["id", "label", "endpoint", "credential", "tools", ...(value.version !== 1 ? ["enabled"] : []), ...(Number(value.version) >= 3 ? ["cua"] : []), ...(value.version === 4 ? ["toolEffects"] : [])].includes(key)) || (value.version !== 1 && typeof raw.enabled !== "boolean") || typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.id) || ids.has(raw.id) || !text(raw.label, 128) || (raw.cua === undefined && !text(raw.endpoint, 4096)) || !Array.isArray(raw.tools)) throw invalid();
    ids.add(raw.id);
    let cua: Extract<CuaConfig, { kind: "cua-linux" }> | undefined;
    if (raw.cua !== undefined) { const parsed = parseCuaConfig(raw.cua); if (Number(value.version) < 3 || parsed.kind !== "cua-linux" || raw.endpoint !== undefined || raw.credential !== undefined || raw.toolEffects !== undefined) throw invalid(); cua = parsed; }
    else { try { if (parseMcpEndpoint(raw.endpoint as string).hash) throw invalid(); } catch { throw invalid(); } }
    let credential: PersonalMcpCredential | undefined;
    if (raw.credential !== undefined) {
      if (!object(raw.credential) || !validPath(raw.credential.path)) throw invalid();
      const key = value.version === 4 && "tokenSha256" in raw.credential ? "tokenSha256" : "sha256";
      if (Object.keys(raw.credential).some(item => !["path", key].includes(item)) || typeof raw.credential[key] !== "string" || !/^[0-9a-f]{64}$/.test(raw.credential[key])) throw invalid();
      credential = key === "tokenSha256" ? { path: raw.credential.path, tokenSha256: raw.credential[key] } : { path: raw.credential.path, sha256: raw.credential[key] };
    }
    const names = new Set<string>();
    const tools = raw.tools.map((tool): PersonalMcpTool => {
      if (!object(tool) || typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || names.has(tool.name) || (tool.description !== undefined && (typeof tool.description !== "string")) || (tool.title !== undefined && typeof tool.title !== "string") || !object(tool.inputSchema) || tool.inputSchema.type !== "object") throw invalid();
      if (tool.annotations !== undefined && (!object(tool.annotations) || Object.entries(tool.annotations).some(([key, item]) => key === "title" ? typeof item !== "string" : ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].includes(key) && typeof item !== "boolean"))) throw invalid();
      const remote = JSON.parse(JSON.stringify(tool)) as PersonalMcpTool;
      if ("disabledReason" in validateRemoteTool(remote)) throw invalid();
      names.add(remote.name);
      return structuredClone(remote);
    });
    let toolEffects: Record<string, PersonalMcpToolEffect> | undefined;
    if (value.version === 4 && !cua) {
      if (!object(raw.toolEffects) || Object.keys(raw.toolEffects).length !== names.size || Object.entries(raw.toolEffects).some(([name, effect]) => !names.has(name) || typeof effect !== "string" || !["read", "write", "unknown"].includes(effect))) throw invalid();
      toolEffects = raw.toolEffects as Record<string, PersonalMcpToolEffect>;
    }
    return { id: raw.id, label: raw.label, ...(cua ? { cua } : { endpoint: raw.endpoint as string, ...(credential ? { credential } : {}), ...(toolEffects ? { toolEffects: { ...toolEffects } } : {}) }), tools, ...(value.version !== 1 ? { enabled: raw.enabled as boolean } : {}) };
  });
  return { version: value.version as PersonalMcpConfig["version"], generation: value.generation, services };
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
    return { token, sha256: createHash("sha256").update(bytes).digest("hex"), tokenSha256: createHash("sha256").update(token).digest("hex") };
  } catch (error) {
    if (error instanceof PersonalError && error.code === "mcp_credentials_invalid") throw error;
    throw credentialError();
  }
}

export function personalMcpCredential(filename: string): PersonalMcpCredential {
  return { path: filename, tokenSha256: tokenFile(filename).tokenSha256 };
}

/** 匿名服务返回空字符串；配置了凭据时逐请求重读，失效会拒绝，调用方不得降级匿名。 */
export async function resolvePersonalMcpToken(service: McpTarget): Promise<string> {
  if (service.cua) { await cuaProgram(service.cua); return ""; }
  if (!service.credential) return "";
  const saved = tokenFile(service.credential.path);
  if ("tokenSha256" in service.credential ? saved.tokenSha256 !== service.credential.tokenSha256 : saved.sha256 !== service.credential.sha256) throw credentialError();
  return saved.token;
}

/** 只核实新增、启用或改变连接认证的服务；原调用仍逐请求核实固定凭据。 */
export async function validatePersonalMcpCredentials(config: PersonalMcpConfig, current: PersonalMcpConfig | undefined): Promise<void> {
  for (const service of config.services) {
    if (service.enabled === false) continue;
    const previous = current?.services.find(item => item.id === service.id);
    if (!previous || previous.enabled === false || !isDeepStrictEqual(previous.credential, service.credential) || !isDeepStrictEqual(previous.cua, service.cua)) await resolvePersonalMcpToken(service);
  }
}

/** 返回完整发现结果；允许列表由拥有者选择，连接在返回或失败时关闭。 */
export async function discoverPersonalMcp(service: McpTarget): Promise<PersonalMcpTool[]> {
  const connection = service.cua ? await connectMcpStdio({ serviceId: service.id, ...await cuaProgram(service.cua) }) : await connectMcpEndpoint({ serviceId: service.id, endpoint: service.endpoint! }, service.credential ? { resolveToken: () => resolvePersonalMcpToken(service) } : {});
  try { return JSON.parse(JSON.stringify(await connection.listTools())) as PersonalMcpTool[]; }
  finally { await connection.close(); }
}

// Note: 见 .agents/notes/implemented/architecture/2026-10-17-personal-durable-mcp.md
export async function savePersonalMcp(target: string | PersonalProfileLock, value: unknown): Promise<void> {
  const config = parsePersonalMcp(value);
  const { readPersonalSettings, savePersonalSettings } = await import("./personal-settings.ts");
  const snapshot = await readPersonalSettings(target);
  if (snapshot.mcp && snapshot.mcp.version > config.version) throw new PersonalError("mcp_config_downgrade", "MCP 已迁入新格式，请使用当前格式修改；未覆盖原配置。");
  await savePersonalSettings(target, snapshot, snapshot.revisions.mcp, { kind: "config.save", target: "mcp", value: { ...config, services: config.services.map(service => service.cua ? service : { ...service, authentication: service.credential ? "credential" : "anonymous" }) } });
}

/** 显式迁入独立工具效果格式；原历史与凭据引用不改写，已迁入时返回当前配置。 */
export async function migratePersonalMcp(target: string | PersonalProfileLock): Promise<void> {
  const directory = typeof target === "string" ? target : target.directory;
  const filename = path.join(directory, "mcp.json");
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })) throw new PersonalError("mcp_config_missing", "尚未配置 MCP 服务，请先保存服务配置。");
  let bytes: Buffer, value: unknown;
  try { bytes = privateFile(filename, Number.MAX_SAFE_INTEGER); } catch { throw invalid(); }
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw invalid(); }
  const config = parsePersonalMcp(value);
  if (config.version === 4) return;
  const { executePersonalSettings, personalSettingsDirectoryIdentity } = await import("./personal-settings.ts");
  await executePersonalSettings(target, { v: 2, id: randomUUID(), profile: personalSettingsDirectoryIdentity(directory), expectedRevision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, op: { kind: "mcp.migrate" } });
}
