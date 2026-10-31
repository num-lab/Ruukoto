/** Cua pinned artifacts, host launch arguments and model tool restrictions;
 *  durable binding and recovery belong to the product.
 * Note: See .agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { McpError, type McpRemoteTool, type McpStdioProgram } from "./transport.ts";
import { allowlistEffectFor, type McpAllowlistEntry, type McpToolEffect } from "./store.ts";

interface CuaArtifact { executable: string; sha256: string }
export type CuaConfig =
  | CuaArtifact & { kind: "cua-mac"; version: "0.38.0" }
  | CuaArtifact & { kind: "cua-linux"; version: "0.7.0"; sandbox: string; sandboxId: string };

const invalid = () => new McpError("cua_config_invalid", "电脑配置不完整或制品不受支持；请拥有者重新核实官方程序与固定目标。");

/** JSON config boundary: exact version match, unknown fields refused, no env or
 *  arbitrary command arguments can be passed in. */
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

/** Verify the pinned artifact on every new connection; the minimal env carries
 *  no product credentials, target and permissions are host-generated. */
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
/** Fields of unexposed capabilities: zoom is not offered, so from_zoom can never
 *  be authorized; nested validation refuses it as well. */
const UNEXPOSED_FIELDS = ["from_zoom"];
const OBSERVE_TOOL = "get_window_state";

export function cuaToolEffect(config: CuaConfig, name: string): McpToolEffect | null {
  const linux = config.kind === "cua-linux";
  return (linux ? LINUX_READ : MAC_READ).has(name) ? "read" : (linux ? LINUX_WRITE : MAC_WRITE).has(name) ? "write" : null;
}

export const CUA_BATCH_MAX_STEPS = 8;
/** The batch action set is narrower than upstream: set_value only accepts an
 *  element target, and the pinned driver's stale-element retry misclassifies a
 *  partially applied text input as a stale element and replays the whole input;
 *  type_text therefore takes only coordinate or focus targets. */
const CUA_BATCH_STEP_TOOLS = ["click", "double_click", "right_click", "type_text", "press_key", "hotkey", "scroll", "drag", "move_cursor"] as const;
const CUA_BATCH_DELAY_MS = 2_000;
const CUA_BATCH_FIND_TIMEOUT_MS = 10_000;
const CUA_BATCH_TEXT_CHARS = 1024;
/** Per-step argument shapes: types, enums and pinned-upstream numeric bounds
 *  (nested fields are listed separately). */
type FieldType = "integer" | "number" | "string" | "boolean" | "strings" | "object" | "array";
interface FieldSpec { type: FieldType; enum?: readonly string[]; required?: boolean; minChars?: number; maxChars?: number; min?: number; max?: number; minItems?: number; nullable?: boolean }
const DELIVERY: FieldSpec = { type: "string", enum: ["background", "foreground"] };
const STEP_ARG_FIELDS: Record<string, Record<string, FieldSpec>> = {
  click: { action: { type: "string" }, button: { type: "string", enum: ["left", "right", "middle"] }, capture_id: { type: "string" }, count: { type: "integer", min: 1 }, delivery_mode: DELIVERY, element_token: { type: "string" }, modifier: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  double_click: { delivery_mode: DELIVERY, element_token: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
  right_click: { delivery_mode: DELIVERY, element_token: { type: "string" }, modifier: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  type_text: { delay_ms: { type: "integer", min: 0, max: 200 }, delivery_mode: DELIVERY, element_token: { type: "string" }, text: { type: "string", required: true, maxChars: CUA_BATCH_TEXT_CHARS }, x: { type: "number" }, y: { type: "number" } },
  press_key: { delivery_mode: DELIVERY, element_token: { type: "string" }, key: { type: "string", required: true, minChars: 1 }, modifiers: { type: "strings" }, x: { type: "number" }, y: { type: "number" } },
  hotkey: { delivery_mode: DELIVERY, element_token: { type: "string" }, keys: { type: "strings", required: true, minItems: 1 }, x: { type: "number" }, y: { type: "number" } },
  scroll: { amount: { type: "integer", min: 1, max: 50 }, by: { type: "string", enum: ["line", "page"] }, delivery_mode: DELIVERY, direction: { type: "string", required: true, enum: ["up", "down", "left", "right"] }, element_token: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
  drag: { button: { type: "string", enum: ["left", "right", "middle"] }, delivery_mode: DELIVERY, duration_ms: { type: "integer", min: 0, max: 10_000 }, from_x: { type: "number", required: true }, from_y: { type: "number", required: true }, modifier: { type: "strings" }, steps: { type: "integer", min: 1, max: 200 }, to_x: { type: "number", required: true }, to_y: { type: "number", required: true } },
  move_cursor: { cursor_id: { type: "string" }, delivery_mode: DELIVERY, x: { type: "number", required: true }, y: { type: "number", required: true } },
};
/** Element selectors allowed inside step args (role/name lookup within the
 *  batch window; app/window retargeting is not listed). */
const STEP_SELECTOR_FIELDS: Record<string, FieldSpec> = { role: { type: "string" }, name: { type: "string" }, label: { type: "string" }, nth: { type: "integer", min: 0 } };
const STEP_SELECTOR_KEYS = Object.keys(STEP_SELECTOR_FIELDS);
/** Window/session/file-output fields forbidden inside step args: the batch has
 *  exactly one observed window and the host owns the session. */
const STEP_FORBIDDEN_FIELDS = [...HOST_FIELDS, "pid", "window_id", "app", "window", "scope", "target", "from_zoom", "wait_for", "expect"];
/** observe fields = get_window_state parameters minus host fields; pid/window_id
 *  when given must equal the batch window. */
const OBSERVE_FIELDS: Record<string, FieldSpec> = {
  capture_mode: { type: "string", enum: ["ax", "vision"] }, display_only: { type: "boolean" }, full_output: { type: "boolean" },
  include_accessibility_tree: { type: "boolean" }, include_screenshot: { type: "boolean" }, max_depth: { type: "integer", min: 1 },
  max_dimension: { type: "integer", min: 1 }, max_elements: { type: "integer", min: 1 }, max_image_dimension: { type: "integer", min: 0 },
  pid: { type: "integer" }, query: { type: "string" }, since: { type: "string", nullable: true }, timeout_ms: { type: "integer", min: 100, max: 120_000 },
  tree_format: { type: "string", enum: ["markdown", "elements", "both"] }, verbose: { type: "boolean" }, window_id: { type: "integer" },
};
/** The pinned upstream normalizes symbol-named press_key into type_text (most
 *  symbols need Shift and are text, not key chords). */
const SYMBOL_KEY_NAMES: Record<string, string> = { asterisk: "*", star: "*", plus: "+", at: "@", hash: "#", numbersign: "#", pound: "#", dollar: "$", percent: "%", caret: "^", ampersand: "&", exclamation: "!", exclam: "!", question: "?", questionmark: "?", underscore: "_", tilde: "~", colon: ":", pipe: "|", bar: "|", less: "<", lessthan: "<", greater: ">", greaterthan: ">", parenleft: "(", leftparen: "(", parenright: ")", rightparen: ")", braceleft: "{", braceright: "}", quotedbl: "\"", doublequote: "\"" };
const SHIFTED_SYMBOLS = "*+@#$%^&!?_~:|<>(){}\"";
/** Pinned upstream keyboard.rs: modifier names used to split hotkey chords into
 *  modifiers + base key. */
const HOTKEY_MODIFIERS = new Set(["cmd", "command", "super", "meta", "win", "shift", "option", "alt", "ctrl", "control", "fn"]);
/** Pinned upstream keyboard.rs canonical_key_name folds: longer key names lose
 *  spaces/underscores/hyphens, then common spellings collapse onto one name. */
const KEY_NAME_FOLDS: Record<string, string> = { pgdn: "pagedown", pgdown: "pagedown", pgup: "pageup", arrowleft: "left", leftarrow: "left", arrowright: "right", rightarrow: "right", arrowup: "up", uparrow: "up", arrowdown: "down", downarrow: "down", forwarddelete: "forward_delete", fwddelete: "forward_delete", deleteforward: "forward_delete", bksp: "backspace", escape: "escape", kpenter: "enter", numpadenter: "enter" };
/** Pinned upstream keyboard.rs key_name_to_code: every canonical name that
 *  resolves to a key code. */
const KEY_CODE_NAMES = new Set(["return", "enter", "tab", "space", "delete", "backspace", "escape", "esc", "command", "cmd", "super", "meta", "win", "shift", "capslock", "option", "alt", "control", "ctrl", "fn", "home", "pageup", "del", "forward_delete", "end", "pagedown", "left", "left_arrow", "right", "right_arrow", "down", "down_arrow", "up", "up_arrow", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "a", "s", "d", "f", "h", "g", "z", "x", "c", "v", "b", "q", "w", "e", "r", "y", "t", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "=", "-", "]", "o", "u", "[", "i", "p", "l", "j", "'", "k", ";", "\\", ",", "/", "n", "m", ".", "`"]);
/** canonical_key_name equivalent: trim and lowercase; single characters pass
 *  through unchanged, longer names compact then fold. */
const canonicalKeyName = (key: string): string => {
  const lower = key.trim().toLowerCase();
  if ([...lower].length < 2) return lower;
  const compact = lower.replace(/[ _-]/g, "");
  return KEY_NAME_FOLDS[compact] ?? compact;
};
const keyNameValid = (key: string): boolean => KEY_CODE_NAMES.has(canonicalKeyName(key));
/** Pinned upstream ax_actions::map_action results: names compared after
 *  stripping "_" and "-", lowercasing and dropping a leading "ax". */
const CLICK_AX_ACTIONS = new Set(["press", "click", "showmenu", "rightclick", "pick", "confirm", "cancel", "open", "showalternateui", "showdefaultui"]);
/** validate_click_action equivalent: "focus" is accepted verbatim only on the
 *  pixel path (no element target); every other action must map. */
const clickActionValid = (action: string, elementTarget: boolean): boolean => {
  if (!elementTarget && action === "focus") return true;
  return CLICK_AX_ACTIONS.has(action.replace(/[_-]/g, "").toLowerCase().replace(/^ax/, ""));
};
const RUN_STEPS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["steps", "pid", "window_id", "observe"],
  properties: {
    steps: { type: "array", minItems: 1, maxItems: CUA_BATCH_MAX_STEPS, items: { type: "object", additionalProperties: false, required: ["tool", "args"], properties: { tool: { type: "string", enum: [...CUA_BATCH_STEP_TOOLS], description: "动作工具名（仅允许本名，别名与简写不被接受）" }, args: { type: "object", description: "该工具的参数；不得含 pid/window_id/app/window/scope/target/session 等窗口或会话字段。目标方式 element_token、x/y 坐标、role/name/label(/nth) 选择器三者互斥：click/double_click/right_click 必须选其一（click 不可用选择器）；type_text 必填 text（≤1024 字符）且只接受坐标或焦点目标；press_key 必填 key（须为驱动可识别的键名）；hotkey 必填 keys（至少一个非修饰键）；scroll 必填 direction；drag 必填 from_x/from_y/to_x/to_y；move_cursor 必填 x,y" }, timeout_ms: { type: "integer", minimum: 0, maximum: CUA_BATCH_FIND_TIMEOUT_MS } } } },
    pid: { type: "integer", minimum: 1, description: "批次窗口进程 ID（来自已交付的窗口观察）" },
    window_id: { type: "integer", description: "批次窗口 ID（与 pid 一起来自已交付的窗口观察）" },
    delay_ms: { type: "integer", minimum: 0, maximum: CUA_BATCH_DELAY_MS },
    delivery_mode: { type: "string", enum: ["background", "foreground"], description: "各步默认投递方式；步骤自身的 delivery_mode 优先" },
    observe: { type: "object", description: "必填：末尾一次 get_window_state 的参数；pid/window_id 缺省取批次窗口，若给必须一致。include_screenshot 缺省 false，include_accessibility_tree 缺省 true，至少开启一项；display_only:true 必须关闭树并开启截图" },
  },
} satisfies Record<string, unknown>;

/** The original schema is stored separately by the product; the model only sees
 *  allowed tools and submittable fields — host targets are never model-supplied. */
export function restrictCuaTool(config: CuaConfig, remote: McpRemoteTool): McpRemoteTool | undefined {
  if (!cuaToolEffect(config, remote.name)) return undefined;
  const mac = config.kind === "cua-mac";
  const base = `电脑目标和连接由宿主管理，使用最新观察中的窗口、元素与坐标；未列出的电脑能力不可用。连接中断或结果未知时停止电脑操作，报告拥有者从管理入口核实并恢复。\n${remote.description ?? ""}`;
  if (remote.name === "run_steps") {
    const description = `在一个已观察窗口内按序执行至多 ${CUA_BATCH_MAX_STEPS} 个确定性动作，并以 observe 取得末尾观察；先 get_window_state 观察该窗口。写操作先观察：元素动作使用观察中交付的 element_token，坐标动作需要该窗口已交付的截图。整批一次审批绑定，宿主发送后不再逐步重核；steps 只接受 {tool,args}（可附 timeout_ms≤10s）形式，不支持别名、条件、等待或脚本；子动作与观察都须在服务允许列表。type_text 只接受坐标或焦点目标（不接受 element_token/选择器），set_value 不在批次内；菜单栏元素的 click 会被钉版驱动改执行为 invoke_menu，故不接受菜单栏元素令牌（elements 格式观察无可判定行，其令牌同样不授权 click），菜单请用 hotkey 或等价键。执行到首个失败步停止：executed 计已报告步数而非已确认效果，失败步可能有部分效果，顶层成功不代表末尾观察有效或任务已完成；批次派发后旧观察授权作废，仅由有效交付的末尾观察恢复；失败或结果不明时重新观察并计划新批次，不要原样重放。\n${base}`;
    return { ...remote, description, inputSchema: RUN_STEPS_SCHEMA };
  }
  const schema = remote.inputSchema;
  const properties = { ...(schema.properties as Record<string, unknown> | undefined) };
  for (const key of [...HOST_FIELDS, ...(mac ? UNEXPOSED_FIELDS : [])]) delete properties[key];
  const dropped = [...HOST_FIELDS, ...(mac ? UNEXPOSED_FIELDS : [])];
  const required = (schema.required as string[] | undefined)?.filter(key => !dropped.includes(key));
  const effect = cuaToolEffect(config, remote.name);
  const precondition = effect === "write" ? "写操作先观察：元素动作用已交付的 element_token，坐标动作需要目标窗口已交付的截图。" : remote.name === "verify_state" ? "谓词结果不构成可执行观察，不能放行写操作。" : "";
  return { ...remote, description: `${precondition}${base}`, inputSchema: { ...schema, properties, ...(required ? { required } : {}), additionalProperties: false } };
}

function batchError(message: string): McpError {
  return new McpError("cua_batch_invalid", `批次参数无效：${message}；该请求未发送。`);
}

function checkField(spec: FieldSpec, value: unknown, at: string): void {
  const bad = (): never => { throw batchError(`${at} 应为 ${spec.type}${spec.min !== undefined ? ` ≥${spec.min}` : ""}${spec.max !== undefined ? ` ≤${spec.max}` : ""}`); };
  if (spec.nullable && value === null) return;
  switch (spec.type) {
    case "integer": if (!Number.isInteger(value)) bad(); break;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) bad(); break;
    case "string": {
      const text = typeof value === "string" ? value : bad();
      if (spec.minChars !== undefined && text.length < spec.minChars) throw batchError(`${at} 长度至少 ${spec.minChars} 字符`);
      if (spec.maxChars !== undefined && text.length > spec.maxChars) throw batchError(`${at} 长度不能超过 ${spec.maxChars} 字符（当前 ${text.length} 字符）`);
      break;
    }
    case "boolean": if (typeof value !== "boolean") bad(); break;
    case "strings": if (!Array.isArray(value) || value.some(item => typeof item !== "string")) bad(); if ((value as unknown[]).length < (spec.minItems ?? 0)) throw batchError(`${at} 至少需要 ${spec.minItems} 项`); break;
    case "object": if (!value || typeof value !== "object" || Array.isArray(value)) bad(); break;
    case "array": if (!Array.isArray(value)) bad(); break;
  }
  if ((spec.type === "integer" || spec.type === "number") && ((spec.min !== undefined && (value as number) < spec.min) || (spec.max !== undefined && (value as number) > spec.max))) bad();
  if (spec.enum && !spec.enum.includes(value as string)) bad();
}

function checkObject(value: unknown, fields: Record<string, FieldSpec>, required: readonly string[], at: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw batchError(`${at} 应为对象`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key.startsWith("_")) throw batchError(`${at} 的 ${key} 为保留字段`);
    if (!Object.hasOwn(fields, key)) throw batchError(`${at} 不开放字段 ${key}`);
  }
  for (const key of required) if (object[key] === undefined) throw batchError(`${at} 缺少 ${key}`);
  for (const [key, spec] of Object.entries(fields)) if (object[key] !== undefined) checkField(spec, object[key], `${at} 的 ${key}`);
  return object;
}

/**
 * The pinned upstream's implicit per-step normalization (batch_tools.rs
 * rewrite_step): a one-key hotkey becomes press_key, a symbol-named or single
 * Shift-symbol press_key becomes type_text. The host derives the actually
 * executed tool chain by the same rules; every effective tool must be on the
 * allowlist — tools the normalization cannot reach do not matter.
 */
function effectiveStepTools(tool: string, args: Record<string, unknown>): string[] {
  const chain = [tool];
  let name = tool;
  let key: unknown;
  if (name === "hotkey") {
    const keys = args.keys;
    if (Array.isArray(keys) && keys.length === 1) { name = "press_key"; chain.push(name); key = keys[0]; }
  }
  if (name === "press_key") {
    const noModifiers = !Array.isArray(args.modifiers) || args.modifiers.length === 0;
    const rawKey = key ?? args.key;
    if (noModifiers && typeof rawKey === "string") {
      const trimmed = rawKey.trim(), folded = trimmed.toLowerCase().replace(/[_\- ]/g, "");
      if (SYMBOL_KEY_NAMES[folded] !== undefined || (trimmed.length === 1 && SHIFTED_SYMBOLS.includes(trimmed))) chain.push("type_text");
    }
  }
  return chain;
}

/** Parameters beyond token/coords/selector are allowed but the target shape
 *  must be executable: element token, x,y coordinates and selector are mutually
 *  exclusive. */
type StepTargetMode = "required" | "optional" | "none";
const STEP_TARGET_RULE: Record<string, StepTargetMode> = {
  click: "required", double_click: "required", right_click: "required",
  type_text: "optional", press_key: "optional", hotkey: "optional", scroll: "optional",
  drag: "none", move_cursor: "none",
};

/** The pinned driver's element_token shape constraint (tool_schema.rs pattern). */
const ELEMENT_TOKEN_PATTERN = /^s[0-9a-f]{8}:[0-9]+$/;

function checkStepTarget(tool: string, args: Record<string, unknown>, at: string): void {
  const rule = STEP_TARGET_RULE[tool]!;
  const token = args.element_token !== undefined;
  const selector = STEP_SELECTOR_KEYS.some(key => args[key] !== undefined);
  const coords = args.x !== undefined || args.y !== undefined;
  if (token && (typeof args.element_token !== "string" || !ELEMENT_TOKEN_PATTERN.test(args.element_token))) throw batchError(`${at} 的 element_token 形态无效（应为 s + 8 位十六进制 : 行号）`);
  if ((args.x !== undefined) !== (args.y !== undefined)) throw batchError(`${at} 的 x/y 必须成对给出`);
  if (selector && !["role", "name", "label"].some(key => args[key] !== undefined)) throw batchError(`${at} 的 nth 须与 role/name/label 同用`);
  if (args.name !== undefined && args.label !== undefined) throw batchError(`${at} 的 name 与 label 只能给一个`);
  const modes = [token, coords, selector].filter(Boolean).length;
  if (modes > 1) throw batchError(`${at} 的元素令牌、坐标与选择器只能选一种目标方式`);
  if (rule === "required" && modes === 0) throw batchError(`${at} 需要 element_token、x/y 坐标或 role/name/label 选择器之一`);
  // Selector targets backfill element_token after remote resolution as well: a
  // click on a menu-bar element is rerouted by the pinned driver to invoke_menu,
  // and a selector cannot prove a non-menu target before send, so click takes
  // no selector target.
  if (tool === "click" && selector) throw batchError(`${at} 的 click 不接受选择器目标（菜单栏元素会被钉版驱动改执行为不在批次清单的 invoke_menu）；请用 element_token 或 x/y 坐标`);
  if (rule === "none" && (token || selector)) throw batchError(`${at} 不接受元素目标；${tool} 只按坐标执行`);
  if (args.capture_id !== undefined && !coords) throw batchError(`${at} 的 capture_id 只与 x/y 坐标同用`);
  // The pinned driver's stale-element retry on element-targeted steps replays
  // the entire text input (a partial effect is misclassified as a stale
  // element), so any step whose effective tool is text input refuses element
  // tokens and selectors; coordinate and focus targets take no such path.
  const effective = effectiveStepTools(tool, args);
  if (effective.includes("type_text") && (token || selector)) throw batchError(`${at} 生效为文本输入的步骤不接受元素目标（固定驱动的过期重试会重放整段输入）；请用坐标或先点击聚焦`);
}

type CheckFail = (message: string) => McpError;

/** hotkey chord check (pinned hotkey.rs): at least one non-modifier key, and
 *  the last non-modifier — the only one upstream posts — must resolve. */
function checkKeyChord(keys: string[], background: boolean, at: string, fail: CheckFail): void {
  const nonModifiers = keys.filter(key => !HOTKEY_MODIFIERS.has(key.toLowerCase()));
  if (!nonModifiers.length) throw fail(`${at} 的 keys 需要至少一个非修饰键（如 ["cmd","c"] 中的 "c"）`);
  const key = nonModifiers[nonModifiers.length - 1]!;
  // Only PID-routed background delivery uses press_key's Shift+= remap.
  if (background) checkKeyName(key, at, fail);
  else if (!keyNameValid(key)) throw fail(`${at} 的键名 "${key}" 不是钉版驱动可识别的按键`);
}

/** press_key check (pinned press_key.rs/keyboard.rs): "+" and "plus" remap to
 *  Shift+= and are always valid; every other key name must resolve. */
function checkKeyName(key: string, at: string, fail: CheckFail): void {
  if (key !== "+" && key.toLowerCase() !== "plus" && !keyNameValid(key)) throw fail(`${at} 的键名 "${key}" 不是钉版驱动可识别的按键`);
}

/** click action check (pinned click.rs validate_click_action): element targets
 *  are element_token or any selector field after remote resolution. */
function checkClickAction(args: Record<string, unknown>, at: string, fail: CheckFail): void {
  const action = args.action === undefined ? "press" : args.action;
  if (typeof action !== "string") return;
  const elementTarget = args.element_token !== undefined || STEP_SELECTOR_KEYS.some(key => args[key] !== undefined);
  if (!clickActionValid(action, elementTarget)) throw fail(`${at} 的 action "${action}" 无效（可用 press、show_menu、pick、confirm、cancel、open、show_alternate_ui、show_default_ui；focus 仅坐标目标）`);
}

/** Deterministic invoke-time failures the pinned upstream reports per tool,
 *  mirrored host-side so an invalid suffix cannot let earlier batch steps
 *  execute. Only the final effective tool is judged — normalization rewrites
 *  the call before invoke, so e.g. a symbol press_key is validated as text. */
function checkStepSemantics(tool: string, args: Record<string, unknown>, deliveryMode: unknown, at: string): void {
  const effective = effectiveStepTools(tool, args).at(-1)!;
  if (effective === "hotkey") checkKeyChord(args.keys as string[], (args.delivery_mode ?? deliveryMode) !== "foreground", at, batchError);
  else if (effective === "press_key") {
    const key = tool === "hotkey" ? (args.keys as string[])[0] : args.key;
    if (typeof key === "string") checkKeyName(key, at, batchError);
  }
  if (tool === "click") checkClickAction(args, at, batchError);
}

/**
 * Pre-send batch validation: outer shape, every child action and the trailing
 * observation are checked against the restricted subset of the pinned upstream
 * contract and the current allowlist. Non-canonical forms (aliases,
 * {<tool>:args} shorthand, wait_for/expect, scripts, foreground_fallback) are
 * refused so upstream normalization, implicit calls and fallbacks cannot be
 * triggered by inputs outside the subset; session/target/file-output fields are
 * refused in nested positions as well. Each step's executable combination,
 * deterministic invoke-time checks and numeric bounds are all validated before
 * any send — one invalid step means the whole batch is never sent.
 */
export function cuaBatchArguments(config: CuaConfig, allowlist: readonly McpAllowlistEntry[], raw: Record<string, unknown>): Record<string, unknown> {
  if (config.kind !== "cua-mac") throw new McpError("cua_tool_denied", "该电脑工具未开放；使用当前清单中的观察或界面操作工具，无法完成时报告拥有者。");
  const allowed = (name: string) => allowlistEffectFor([...allowlist], name) !== null;
  const needAllowed = (name: string, at: string) => { if (!allowed(name)) throw batchError(`${at} 的 ${name} 不在服务允许列表`); };
  needAllowed("run_steps", "批次");
  const top = checkObject(raw, {
    steps: { type: "array", required: true }, pid: { type: "integer", required: true }, window_id: { type: "integer", required: true },
    delay_ms: { type: "integer" }, delivery_mode: DELIVERY, observe: { type: "object", required: true },
  }, ["steps", "pid", "window_id", "observe"], "批次");
  if (!Number.isInteger(top.pid) || (top.pid as number) < 1 || !Number.isInteger(top.window_id) || (top.window_id as number) < 1) throw batchError("pid/window_id 须为正整数");
  const steps = top.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > CUA_BATCH_MAX_STEPS) throw batchError(`steps 须为 1–${CUA_BATCH_MAX_STEPS} 个步骤`);
  if (typeof top.delay_ms === "number" && (top.delay_ms < 0 || top.delay_ms > CUA_BATCH_DELAY_MS)) throw batchError(`delay_ms 须在 0–${CUA_BATCH_DELAY_MS} 内`);
  for (const [index, rawStep] of steps.entries()) {
    const at = `步骤 ${index + 1}`;
    const step = checkObject(rawStep, { tool: { type: "string", required: true }, args: { type: "object" }, timeout_ms: { type: "integer" } }, ["tool", "args"], at);
    const tool = step.tool as string;
    if (!(CUA_BATCH_STEP_TOOLS as readonly string[]).includes(tool)) throw batchError(`${at} 的 ${tool} 不在批次动作清单（不支持别名、观察、条件、脚本或 set_value 等隐式重试工具）`);
    const args = step.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw batchError(`${at} 的 args 应为对象`);
    for (const key of Object.keys(args as Record<string, unknown>)) {
      if (key.startsWith("_")) throw batchError(`${at} args 的 ${key} 为保留字段`);
      if (STEP_FORBIDDEN_FIELDS.includes(key)) throw batchError(`${at} args 不开放字段 ${key}（批次窗口与会话由宿主/批次固定）`);
      if (!Object.hasOwn(STEP_ARG_FIELDS[tool]!, key) && !Object.hasOwn(STEP_SELECTOR_FIELDS, key)) throw batchError(`${at} args 不开放字段 ${key}`);
    }
    checkObject(args, { ...STEP_ARG_FIELDS[tool], ...STEP_SELECTOR_FIELDS }, Object.entries(STEP_ARG_FIELDS[tool]!).filter(([, spec]) => spec.required).map(([key]) => key), `${at} args`);
    checkStepTarget(tool, args as Record<string, unknown>, at);
    checkStepSemantics(tool, args as Record<string, unknown>, top.delivery_mode, at);
    needAllowed(tool, at);
    for (const effective of effectiveStepTools(tool, args as Record<string, unknown>).slice(1)) {
      if (!allowed(effective)) throw batchError(`${at} 的 ${tool} 经固定驱动归一化等同 ${effective}；${effective} 不在允许列表，批次不静默启用该隐式调用`);
    }
    if (step.timeout_ms !== undefined && ((step.timeout_ms as number) < 0 || (step.timeout_ms as number) > CUA_BATCH_FIND_TIMEOUT_MS)) throw batchError(`${at} 的 timeout_ms 须在 0–${CUA_BATCH_FIND_TIMEOUT_MS} 内`);
  }
  needAllowed(OBSERVE_TOOL, "observe");
  const observe = checkObject(top.observe, OBSERVE_FIELDS, [], "observe");
  // Pinned get_window_state.rs: with both the tree and the screenshot opted out
  // there is nothing to return — refuse before earlier steps can run.
  if (observe.include_screenshot !== true && observe.include_accessibility_tree === false) throw batchError("observe 至少开启截图或树；include_screenshot 缺省 false，关闭树时须显式设为 true");
  if (observe.display_only === true && observe.include_accessibility_tree !== false) throw batchError("observe 的 display_only:true 需要 include_accessibility_tree:false 与 include_screenshot:true");
  if ((observe.pid !== undefined && observe.pid !== top.pid) || (observe.window_id !== undefined && observe.window_id !== top.window_id)) throw batchError("observe 的 pid/window_id 须与批次窗口一致或省略");
  return { ...top, observe: { ...observe, pid: top.pid, window_id: top.window_id } };
}

/** The same deterministic invoke-time checks for standalone calls, so an
 *  approval interaction is never consumed by a call the pinned driver must
 *  refuse. Fields arriving in the wrong shape skip the check — the upstream
 *  parse error reports them better than a guess. */
function checkStandaloneSemantics(name: string, args: Record<string, unknown>): void {
  const fail: CheckFail = message => new McpError("cua_parameter_denied", `参数无效：${message}；该请求未发送。`);
  if (name === "hotkey") {
    const keys = args.keys;
    const desktop = args.scope === "desktop" && args.pid === undefined && args.window_id === undefined;
    if (Array.isArray(keys) && keys.every(key => typeof key === "string")) checkKeyChord(keys as string[], args.delivery_mode !== "foreground" && !desktop, name, fail);
  } else if (name === "press_key") {
    if (typeof args.key === "string") checkKeyName(args.key, name, fail);
  } else if (name === "click") {
    checkClickAction(args, name, fail);
  } else if (name === "get_window_state" && args.include_screenshot === false && args.include_accessibility_tree === false) {
    throw fail("include_screenshot 与 include_accessibility_tree 不能同时为 false（无可返回内容）");
  }
}

/** Reject target overrides again right before send; window, element and
 *  coordinate fields still use the official tools' original arguments. */
export function cuaArguments(config: CuaConfig, name: string, args: Record<string, unknown>, allowlist: readonly McpAllowlistEntry[] = []): Record<string, unknown> {
  if (!cuaToolEffect(config, name)) throw new McpError("cua_tool_denied", "该电脑工具未开放；使用当前清单中的观察或界面操作工具，无法完成时报告拥有者。");
  if (Object.hasOwn(args, "sandbox") || Object.hasOwn(args, "session")) throw new McpError("cua_target_override", "电脑目标由宿主固定，未发送该操作；移除目标覆盖参数后发起新操作。");
  if (HOST_FIELDS.some(key => Object.hasOwn(args, key))) throw new McpError("cua_parameter_denied", "电脑工具不开放文件输出参数，未发送该操作；使用当前工具定义中的参数发起新操作。");
  if (name === "run_steps") return cuaBatchArguments(config, allowlist, args);
  if (config.kind === "cua-mac") checkStandaloneSemantics(name, args);
  return config.kind === "cua-linux" ? { ...args, sandbox: config.sandbox } : { ...args };
}

/** One action's target and required observation kind (write eligibility). */
export type CuaActionNeed =
  | { kind: "token"; sid: string; row: number; windowKey?: string }
  | { kind: "window"; windowKey?: string; coords: boolean }
  | { kind: "desktop" }
  | { kind: "context" }
  | { kind: "unavailable" };

const COORD_FIELDS = ["x", "y", "from_x", "from_y", "to_x", "to_y"];

/** Classify an action's target: element token, window/desktop coordinates or
 *  focus context; classifies only, without checking observations. */
export function cuaActionNeed(args: Record<string, unknown>): CuaActionNeed {
  // zoom is unexposed: coordinates relative to the zoom canvas can never be
  // authorized by a delivered observation.
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
  // Upstream takes the desktop branch only when pid/window_id are both absent;
  // with a window target scope:"desktop" is ignored and x,y read as
  // window-local coordinates.
  if ((args.scope === "desktop" || target?.kind === "desktop") && pid === undefined && windowId === undefined) return { kind: "desktop" };
  const coords = COORD_FIELDS.some(key => args[key] !== undefined);
  return windowKey || coords ? { kind: "window", ...(windowKey ? { windowKey } : {}), coords } : { kind: "context" };
}

/** Vision-capable models are required only for calls whose results can contain
 *  images; tree-only observations, element/text actions and the guide work for
 *  text-only models. */
export function cuaNeedsVision(remoteName: string, args: Record<string, unknown>): boolean {
  if (remoteName === "get_desktop_state") return true;
  if (remoteName === "get_window_state") return args.include_screenshot !== false;
  if (remoteName === "run_steps") {
    const observe = args.observe && typeof args.observe === "object" && !Array.isArray(args.observe) ? args.observe as Record<string, unknown> : undefined;
    return observe?.include_screenshot === true;
  }
  return false;
}

/** Validated run_steps arguments → window key and step list (for observation
 *  eligibility checks). */
export function cuaBatchPlan(args: Record<string, unknown>): { key: string; steps: { tool: string; args: Record<string, unknown> }[] } {
  const steps = (args.steps as { tool: string; args?: Record<string, unknown> }[]).map(step => ({ tool: step.tool, args: step.args ?? {} }));
  return { key: `${args.pid}:${args.window_id}`, steps };
}
