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

const MAC_READ = new Set(["list_apps", "list_windows", "get_window_state", "verify_state", "get_accessibility_tree", "get_screen_size", "get_desktop_state", "get_cursor_position", "get_guide"]);
const MAC_WRITE = new Set(["bring_to_front", "click", "double_click", "right_click", "drag", "type_text", "press_key", "hotkey", "set_value", "scroll", "move_cursor", "run_steps"]);
const LINUX_READ = new Set(["computer_screenshot", "computer_get_screen_size", "computer_get_cursor_position", "computer_get_current_window", "computer_get_accessibility_tree"]);
const LINUX_WRITE = new Set(["computer_click", "computer_double_click", "computer_move_cursor", "computer_mouse_down", "computer_mouse_up", "computer_type", "computer_key", "computer_key_down", "computer_key_up", "computer_hotkey", "computer_scroll", "computer_drag", "computer_accessibility_act"]);
const HOST_FIELDS = ["sandbox", "session", "screenshot_out_file", "debug_image_out"];
/** 未开放能力的字段：zoom 未暴露，from_zoom 无从授权；嵌套校验同样拒绝。 */
const UNEXPOSED_FIELDS = ["from_zoom"];
const OBSERVE_TOOL = "get_window_state";

export function cuaToolEffect(config: CuaConfig, name: string): McpToolEffect | null {
  const linux = config.kind === "cua-linux";
  return (linux ? LINUX_READ : MAC_READ).has(name) ? "read" : (linux ? LINUX_WRITE : MAC_WRITE).has(name) ? "write" : null;
}

export const CUA_BATCH_MAX_STEPS = 8;
const CUA_BATCH_STEP_TOOLS = ["click", "double_click", "right_click", "set_value", "type_text", "press_key", "hotkey", "scroll", "drag", "move_cursor"] as const;
const CUA_BATCH_DELAY_MS = 2_000;
const CUA_BATCH_FIND_TIMEOUT_MS = 10_000;
const CUA_BATCH_TEXT_CHARS = 1024;
/** 批次步骤的参数形态：仅基本类型校验，完整语义以固定上游 schema 为准（嵌套字段另列）。 */
type FieldType = "integer" | "number" | "string" | "boolean" | "strings" | "object" | "array";
interface FieldSpec { type: FieldType; enum?: readonly string[]; required?: boolean; maxChars?: number }
const DELIVERY: FieldSpec = { type: "string", enum: ["background", "foreground"] };
const STEP_ARG_FIELDS: Record<string, Record<string, FieldSpec>> = {
  click: { action: { type: "string" }, button: { type: "string", enum: ["left", "right", "middle"] }, capture_id: { type: "string" }, count: { type: "integer" }, delivery_mode: DELIVERY, element_token: { type: "string" }, modifier: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  double_click: { delivery_mode: DELIVERY, element_token: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
  right_click: { delivery_mode: DELIVERY, element_token: { type: "string" }, modifier: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  set_value: { element_token: { type: "string" }, value: { type: "string", required: true, maxChars: CUA_BATCH_TEXT_CHARS } },
  type_text: { delay_ms: { type: "integer" }, delivery_mode: DELIVERY, element_token: { type: "string" }, text: { type: "string", required: true, maxChars: CUA_BATCH_TEXT_CHARS }, x: { type: "number" }, y: { type: "number" } },
  press_key: { delivery_mode: DELIVERY, element_token: { type: "string" }, key: { type: "string", required: true }, modifiers: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  hotkey: { delivery_mode: DELIVERY, element_token: { type: "string" }, keys: { type: "strings", required: true }, x: { type: "number" }, y: { type: "number" } },
  scroll: { amount: { type: "integer" }, by: { type: "string", enum: ["line", "page"] }, delivery_mode: DELIVERY, direction: { type: "string", required: true, enum: ["up", "down", "left", "right"] }, element_token: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
  drag: { button: { type: "string", enum: ["left", "right", "middle"] }, delivery_mode: DELIVERY, duration_ms: { type: "integer" }, from_x: { type: "number", required: true }, from_y: { type: "number", required: true }, modifier: { type: "strings" }, steps: { type: "integer" }, to_x: { type: "number", required: true }, to_y: { type: "number", required: true } },
  move_cursor: { cursor_id: { type: "string" }, delivery_mode: DELIVERY, x: { type: "number", required: true }, y: { type: "number", required: true } },
};
/** 步骤 args 内允许的元素选择器（批次窗口内按角色/名称查找；app/window 重定向不在此列）。 */
const STEP_SELECTOR_FIELDS: Record<string, FieldSpec> = { role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, nth: { type: "integer" } };
/** 步骤 args 内禁止的窗口/会话/文件输出字段：整批只有一个已观察窗口，宿主固定会话。 */
const STEP_FORBIDDEN_FIELDS = [...HOST_FIELDS, "pid", "window_id", "app", "window", "scope", "target", "from_zoom", "wait_for", "expect"];
/** observe 允许字段 = get_window_state 参数减去宿主字段；pid/window_id 若给必须等于批次窗口。 */
const OBSERVE_FIELDS: Record<string, FieldSpec> = {
  capture_mode: { type: "string", enum: ["ax", "vision"] }, display_only: { type: "boolean" }, full_output: { type: "boolean" },
  include_accessibility_tree: { type: "boolean" }, include_screenshot: { type: "boolean" }, max_depth: { type: "integer" },
  max_dimension: { type: "integer" }, max_elements: { type: "integer" }, max_image_dimension: { type: "integer" },
  pid: { type: "integer" }, query: { type: "string" }, since: { type: "string" }, timeout_ms: { type: "integer" },
  tree_format: { type: "string", enum: ["markdown", "elements", "both"] }, verbose: { type: "boolean" }, window_id: { type: "integer" },
};
const RUN_STEPS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["steps", "pid", "window_id", "observe"],
  properties: {
    steps: { type: "array", minItems: 1, maxItems: CUA_BATCH_MAX_STEPS, items: { type: "object", additionalProperties: false, required: ["tool", "args"], properties: { tool: { type: "string", enum: [...CUA_BATCH_STEP_TOOLS], description: "动作工具名（仅允许本名，别名与简写不被接受）" }, args: { type: "object", description: "该工具的参数；不得含 pid/window_id/app/window/scope/target/session 等窗口或会话字段" }, timeout_ms: { type: "integer", minimum: 0, maximum: CUA_BATCH_FIND_TIMEOUT_MS } } } },
    pid: { type: "integer", description: "批次窗口进程 ID（来自已交付的窗口观察）" },
    window_id: { type: "integer", description: "批次窗口 ID（与 pid 一起来自已交付的窗口观察）" },
    delay_ms: { type: "integer", minimum: 0, maximum: CUA_BATCH_DELAY_MS },
    delivery_mode: { type: "string", enum: ["background", "foreground"], description: "各步默认投递方式；步骤自身的 delivery_mode 优先" },
    observe: { type: "object", description: "必填：末尾一次 get_window_state 的参数；pid/window_id 缺省取批次窗口，若给必须一致" },
  },
} satisfies Record<string, unknown>;

/** 原 schema 另由产品保存；模型只见允许工具与可提交字段，宿主目标不由模型提供。 */
export function restrictCuaTool(config: CuaConfig, remote: McpRemoteTool): McpRemoteTool | undefined {
  if (!cuaToolEffect(config, remote.name)) return undefined;
  const mac = config.kind === "cua-mac";
  const base = `电脑目标和连接由宿主管理，使用最新观察中的窗口、元素与坐标；未列出的电脑能力不可用。连接中断或结果未知时停止电脑操作，报告拥有者从管理入口核实并恢复。\n${remote.description ?? ""}`;
  if (remote.name === "run_steps") {
    const description = `在一个已观察窗口内按序执行至多 ${CUA_BATCH_MAX_STEPS} 个确定性动作，并以 observe 取得末尾观察；先 get_window_state 观察该窗口。写操作先观察：元素动作使用观察中交付的 element_token，坐标动作需要该窗口已交付的截图。整批一次审批绑定，宿主发送后不再逐步重核；steps 只接受 {tool,args} 形式，不支持别名、条件、等待或脚本。执行到首个失败步停止：executed 计已报告步数而非已确认效果，失败步可能有部分效果，顶层成功不代表末尾观察有效或任务已完成；失败或结果不明时重新观察并计划新批次，不要原样重放。\n${base}`;
    return { ...remote, description, inputSchema: RUN_STEPS_SCHEMA };
  }
  const schema = remote.inputSchema;
  const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
  for (const key of [...HOST_FIELDS, ...(mac ? UNEXPOSED_FIELDS : [])]) delete properties[key];
  const required = (schema.required as string[] | undefined)?.filter(key => !HOST_FIELDS.includes(key));
  const effect = cuaToolEffect(config, remote.name);
  const precondition = effect === "write" ? "写操作先观察：元素动作用已交付的 element_token，坐标动作需要目标窗口已交付的截图。" : remote.name === "verify_state" ? "谓词结果不构成可执行观察，不能放行写操作。" : "";
  return { ...remote, description: `${precondition}${base}`, inputSchema: { ...schema, properties, ...(required ? { required } : {}), additionalProperties: false } };
}

function batchError(message: string): McpError {
  return new McpError("cua_batch_invalid", `批次参数无效：${message}；该请求未发送。`);
}

function checkField(spec: FieldSpec, value: unknown, at: string): void {
  const bad = () => { throw batchError(`${at} 应为 ${spec.type}`); };
  switch (spec.type) {
    case "integer": if (!Number.isInteger(value)) bad(); break;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) bad(); break;
    case "string": if (typeof value !== "string" || (spec.maxChars !== undefined && value.length > spec.maxChars)) bad(); break;
    case "boolean": if (typeof value !== "boolean") bad(); break;
    case "strings": if (!Array.isArray(value) || value.some(item => typeof item !== "string")) bad(); break;
    case "object": if (!value || typeof value !== "object" || Array.isArray(value)) bad(); break;
    case "array": if (!Array.isArray(value)) bad(); break;
  }
  if (spec.enum && !spec.enum.includes(value as string)) bad();
}

function checkObject(value: unknown, fields: Record<string, FieldSpec>, required: readonly string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw batchError(`${at} 应为对象`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key.startsWith("_")) throw batchError(`${at} 的 ${key} 为保留字段`);
    if (!fields[key]) throw batchError(`${at} 不开放字段 ${key}`);
  }
  for (const key of required) if (object[key] === undefined) throw batchError(`${at} 缺少 ${key}`);
  for (const [key, spec] of Object.entries(fields)) if (object[key] !== undefined) checkField(spec, object[key], `${at} 的 ${key}`);
  return object;
}

/**
 * 发送前的批次校验：外层形状、每个子动作与观察都对照固定上游契约的受限子集。
 * 非规范形式（别名、{<tool>:args} 简写、wait_for/expect、脚本、前台回退）一律拒绝，
 * 使上游规范化、隐式调用与回退无法被子集外输入触发；会话/目标/文件输出在嵌套位置同样拒绝。
 */
export function cuaBatchArguments(config: CuaConfig, raw: Record<string, unknown>): Record<string, unknown> {
  if (config.kind !== "cua-mac") throw new McpError("cua_tool_denied", "该电脑工具未开放；使用当前清单中的观察或界面操作工具，无法完成时报告拥有者。");
  const top = checkObject(raw, {
    steps: { type: "array", required: true }, pid: { type: "integer", required: true }, window_id: { type: "integer", required: true },
    delay_ms: { type: "integer" }, delivery_mode: DELIVERY, observe: { type: "object", required: true },
  }, ["steps", "pid", "window_id", "observe"], "批次");
  if (!Number.isInteger(top.pid) || (top.pid as number) < 1 || !Number.isInteger(top.window_id)) throw batchError("pid/window_id 须为正整数");
  const steps = top.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > CUA_BATCH_MAX_STEPS) throw batchError(`steps 须为 1–${CUA_BATCH_MAX_STEPS} 个步骤`);
  if (typeof top.delay_ms === "number" && (top.delay_ms < 0 || top.delay_ms > CUA_BATCH_DELAY_MS)) throw batchError(`delay_ms 须在 0–${CUA_BATCH_DELAY_MS} 内`);
  for (const [index, rawStep] of steps.entries()) {
    const at = `步骤 ${index + 1}`;
    const step = checkObject(rawStep, { tool: { type: "string", required: true }, args: { type: "object" }, timeout_ms: { type: "integer" } }, ["tool", "args"], at);
    const tool = step.tool as string;
    if (!(CUA_BATCH_STEP_TOOLS as readonly string[]).includes(tool)) throw batchError(`${at} 的 ${tool} 不在批次动作清单（不支持别名、观察、条件或脚本工具）`);
    const args = step.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw batchError(`${at} 的 args 应为对象`);
    for (const key of Object.keys(args as Record<string, unknown>)) {
      if (key.startsWith("_")) throw batchError(`${at} args 的 ${key} 为保留字段`);
      if (STEP_FORBIDDEN_FIELDS.includes(key)) throw batchError(`${at} args 不开放字段 ${key}（批次窗口与会话由宿主/批次固定）`);
      if (!STEP_ARG_FIELDS[tool]![key] && !STEP_SELECTOR_FIELDS[key]) throw batchError(`${at} args 不开放字段 ${key}`);
    }
    checkObject(args, { ...STEP_ARG_FIELDS[tool], ...STEP_SELECTOR_FIELDS }, Object.entries(STEP_ARG_FIELDS[tool]!).filter(([, spec]) => spec.required).map(([key]) => key), `${at} args`);
    if (step.timeout_ms !== undefined && ((step.timeout_ms as number) < 0 || (step.timeout_ms as number) > CUA_BATCH_FIND_TIMEOUT_MS)) throw batchError(`${at} 的 timeout_ms 须在 0–${CUA_BATCH_FIND_TIMEOUT_MS} 内`);
  }
  const observe = checkObject(top.observe, OBSERVE_FIELDS, [], "observe");
  if ((observe.pid !== undefined && observe.pid !== top.pid) || (observe.window_id !== undefined && observe.window_id !== top.window_id)) throw batchError("observe 的 pid/window_id 须与批次窗口一致或省略");
  return raw;
}

/** 发送前再拒绝目标覆盖；窗口、元素和坐标仍使用官方工具原参数。 */
export function cuaArguments(config: CuaConfig, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (!cuaToolEffect(config, name)) throw new McpError("cua_tool_denied", "该电脑工具未开放；使用当前清单中的观察或界面操作工具，无法完成时报告拥有者。");
  if (Object.hasOwn(args, "sandbox") || Object.hasOwn(args, "session")) throw new McpError("cua_target_override", "电脑目标由宿主固定，未发送该操作；移除目标覆盖参数后发起新操作。");
  if (HOST_FIELDS.some(key => Object.hasOwn(args, key))) throw new McpError("cua_parameter_denied", "电脑工具不开放文件输出参数，未发送该操作；使用当前工具定义中的参数发起新操作。");
  if (name === "run_steps") return cuaBatchArguments(config, args);
  return config.kind === "cua-linux" ? { ...args, sandbox: config.sandbox } : { ...args };
}

/** 一次动作的目标与所需观察种类（写操作的观察资格判定）。 */
export type CuaActionNeed =
  | { kind: "token"; sid: string; row: number; windowKey?: string }
  | { kind: "window"; windowKey?: string; coords: boolean }
  | { kind: "desktop" }
  | { kind: "context" }
  | { kind: "unavailable" };

const COORD_FIELDS = ["x", "y", "from_x", "from_y", "to_x", "to_y"];

/** 解析动作参数的目标：元素令牌、窗口/桌面坐标或焦点上下文；不核实观察，只分类。 */
export function cuaActionNeed(args: Record<string, unknown>): CuaActionNeed {
  // zoom 未开放：以缩放画布为参照的坐标永远无法被已交付观察授权
  if (args.from_zoom === true) return { kind: "unavailable" };
  const token = typeof args.element_token === "string" && args.element_token ? args.element_token : undefined;
  const target = args.target && typeof args.target === "object" && !Array.isArray(args.target) ? args.target as Record<string, unknown> : undefined;
  const pid = args.pid ?? target?.pid, windowId = args.window_id ?? target?.window_id;
  const windowKey = pid !== undefined && windowId !== undefined ? `${pid}:${windowId}` : undefined;
  if (token) {
    const split = token.split(":");
    const row = split.length === 2 ? Number.parseInt(split[1]!, 10) : NaN;
    return { kind: "token", sid: split[0]!, row, ...(windowKey ? { windowKey } : {}) };
  }
  if (args.scope === "desktop" || target?.kind === "desktop") return { kind: "desktop" };
  const coords = COORD_FIELDS.some(key => args[key] !== undefined);
  return windowKey || coords ? { kind: "window", ...(windowKey ? { windowKey } : {}), coords } : { kind: "context" };
}

/** 调用结果可能包含图片才要求视觉模型；纯树观察、元素/文本动作与指南对文本模型可用。 */
export function cuaNeedsVision(remoteName: string, args: Record<string, unknown>): boolean {
  if (remoteName === "get_desktop_state") return true;
  if (remoteName === "get_window_state") return args.include_screenshot !== false;
  if (remoteName === "run_steps") {
    const observe = args.observe && typeof args.observe === "object" && !Array.isArray(args.observe) ? args.observe as Record<string, unknown> : undefined;
    return observe?.include_screenshot !== false;
  }
  return false;
}

/** 已通过批次校验的 run_steps 参数 → 窗口键与步骤清单（供观察资格判定）。 */
export function cuaBatchPlan(args: Record<string, unknown>): { key: string; steps: { tool: string; args: Record<string, unknown> }[] } {
  const steps = (args.steps as { tool: string; args?: Record<string, unknown> }[]).map(step => ({ tool: step.tool, args: step.args ?? {} }));
  return { key: `${args.pid}:${args.window_id}`, steps };
}
