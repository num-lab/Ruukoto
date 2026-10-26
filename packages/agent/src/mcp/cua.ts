/** Cua 固定制品、宿主启动参数与模型工具限制；持久绑定和恢复由产品负责。
 * Note: 见 .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpError, type McpRemoteTool, type McpStdioProgram } from "./transport.ts";
import type { McpToolEffect } from "./store.ts";

interface CuaArtifact { executable: string; sha256: string }
export type CuaConfig =
  | CuaArtifact & { kind: "cua-mac"; version: "0.38.0" }
  | CuaArtifact & { kind: "cua-linux"; version: "0.7.0"; sandbox: string; sandboxId: string };

const invalid = () => new McpError("cua_config_invalid", "电脑配置不完整或制品不受支持；请拥有者重新核实官方程序与固定目标。");

/** JSON 配置边界；版本精确匹配，未知字段拒绝，不能传入环境或任意命令参数。 */
export function parseCuaConfig(value: unknown): CuaConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const config = value as Record<string, unknown>;
  const linux = config.kind === "cua-linux";
  if ((!linux && config.kind !== "cua-mac") || config.version !== (linux ? "0.7.0" : "0.38.0") ||
      typeof config.executable !== "string" || !path.isAbsolute(config.executable) || /[\r\n\0]/.test(config.executable) ||
      typeof config.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(config.sha256)) throw invalid();
  const fields = ["kind", "version", "executable", "sha256", ...(linux ? ["sandbox", "sandboxId"] : [])];
  if (Object.keys(config).some(key => !fields.includes(key))) throw invalid();
  if (linux && (typeof config.sandbox !== "string" || !/^local:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.sandbox) ||
      typeof config.sandboxId !== "string" || !/^[0-9a-f]{64}$/.test(config.sandboxId))) throw invalid();
  return config as unknown as CuaConfig;
}

/** 每次新连接核实固定制品；最小环境不传产品凭据，目标与权限均由宿主生成。 */
export async function cuaProgram(input: CuaConfig): Promise<McpStdioProgram> {
  const config = parseCuaConfig(input);
  if (process.platform !== (config.kind === "cua-mac" ? "darwin" : "linux")) throw new McpError("cua_platform_unavailable", "当前系统不支持所配置的电脑入口；请拥有者检查产品与目标环境。");
  try {
    const stat = await fs.promises.stat(config.executable);
    if (!stat.isFile()) throw invalid();
    await fs.promises.access(config.executable, fs.constants.X_OK);
    const hash = createHash("sha256");
    for await (const bytes of fs.createReadStream(config.executable)) hash.update(bytes);
    if (hash.digest("hex") !== config.sha256) throw invalid();
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError("cua_artifact_unavailable", "无法核实固定电脑程序；请拥有者检查安装、执行权限与文件哈希。");
  }
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "en_US.UTF-8" };
  for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR"]) {
    const value = process.env[key];
    if (value && !value.startsWith("()")) env[key] = value;
  }
  return { command: config.executable, args: config.kind === "cua-mac" ? ["mcp", "--direct"] :
    ["--embedded", "mcp", "--sandbox", config.sandbox, "--permissions", "computer:screenshot,computer:click,computer:type,computer:key,computer:scroll,computer:hotkey,computer:drag,computer:window,computer:accessibility"], env };
}

const MAC_READ = new Set(["list_apps", "list_windows", "get_window_state", "verify_state", "get_accessibility_tree", "get_screen_size", "get_desktop_state", "get_cursor_position"]);
const MAC_WRITE = new Set(["bring_to_front", "click", "double_click", "right_click", "drag", "type_text", "press_key", "hotkey", "set_value", "scroll", "move_cursor"]);
const LINUX_READ = new Set(["computer_screenshot", "computer_get_screen_size", "computer_get_cursor_position", "computer_get_current_window", "computer_get_accessibility_tree"]);
const LINUX_WRITE = new Set(["computer_click", "computer_double_click", "computer_move_cursor", "computer_mouse_down", "computer_mouse_up", "computer_type", "computer_key", "computer_key_down", "computer_key_up", "computer_hotkey", "computer_scroll", "computer_drag", "computer_accessibility_act"]);
const HOST_FIELDS = ["sandbox", "session", "screenshot_out_file", "debug_image_out"];

export function cuaToolEffect(config: CuaConfig, name: string): McpToolEffect | null {
  const linux = config.kind === "cua-linux";
  return (linux ? LINUX_READ : MAC_READ).has(name) ? "read" : (linux ? LINUX_WRITE : MAC_WRITE).has(name) ? "write" : null;
}

/** 原 schema 另由产品保存；模型只见允许工具与可提交字段，宿主目标不由模型提供。 */
export function restrictCuaTool(config: CuaConfig, remote: McpRemoteTool): McpRemoteTool | undefined {
  if (!cuaToolEffect(config, remote.name)) return undefined;
  const schema = remote.inputSchema;
  const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
  for (const key of HOST_FIELDS) delete properties[key];
  const required = (schema.required as string[] | undefined)?.filter(key => !HOST_FIELDS.includes(key));
  const description = `电脑目标和连接由宿主管理，使用最新观察中的窗口、元素与坐标。连接中断或结果未知时停止电脑操作，报告拥有者从管理入口核实并恢复。\n${remote.description ?? ""}`;
  return { ...remote, description, inputSchema: { ...schema, properties, ...(required ? { required } : {}), additionalProperties: false } };
}

/** 发送前再拒绝目标覆盖；窗口、元素和坐标仍使用官方工具原参数。 */
export function cuaArguments(config: CuaConfig, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!cuaToolEffect(config, name)) throw new McpError("cua_tool_denied", "该电脑工具未开放；使用当前清单中的观察或界面操作工具，无法完成时报告拥有者。");
  if (Object.hasOwn(args, "sandbox") || Object.hasOwn(args, "session")) throw new McpError("cua_target_override", "电脑目标由宿主固定，未发送该操作；移除目标覆盖参数后发起新操作。");
  if (HOST_FIELDS.some(key => Object.hasOwn(args, key))) throw new McpError("cua_parameter_denied", "电脑工具不开放文件输出参数，未发送该操作；使用当前工具定义中的参数发起新操作。");
  return config.kind === "cua-linux" ? { ...args, sandbox: config.sandbox } : { ...args };
}
