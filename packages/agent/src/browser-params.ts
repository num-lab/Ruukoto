import { BrowserError } from "./browser-manager.ts";

export const BROWSER_ACTION_FIELDS: Record<string, string[]> = {
  start: [], attach: ["url"], open: ["url"], snapshot: [], click: ["ref"], fill: ["ref", "text"], select: ["ref", "value"],
  check: ["ref"], uncheck: ["ref"], press: ["key"], scroll: ["direction", "pixels"], wait: ["ms"],
  tabs: ["operation", "index", "url"], screenshot: ["full"], status: [], close: [], pause: [], resume: [],
};

export type BrowserParams = {
  action: string; url?: string; ref?: string; text?: string; value?: string; key?: string;
  direction?: string; pixels?: number; ms?: number; operation?: string; index?: number; full?: boolean;
};

/** 模型 JSON 边界：任意 CLI 管理参数与宿主路径都不属于动作参数。 */
export function browserParams(input: unknown): BrowserParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BrowserError("invalid_params", "浏览器参数必须是对象");
  const params = input as Record<string, unknown>;
  return parseBrowserParams(params);
}

function parseBrowserParams(input: Record<string, unknown>): BrowserParams {
  if (typeof input.ref === "string" && /^e\d+$/.test(input.ref)) input = { ...input, ref: `@${input.ref}` };
  const action = input.action;
  if (typeof action !== "string" || !Object.hasOwn(BROWSER_ACTION_FIELDS, action)) throw new BrowserError("invalid_params", "浏览器动作无效");
  for (const key of Object.keys(input)) if (key !== "action" && !BROWSER_ACTION_FIELDS[action].includes(key)) throw new BrowserError("invalid_params", `动作 ${action} 不接受 ${key}`);
  for (const key of ["url", "ref", "text", "value", "key", "direction", "operation"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length > 65_536)) throw new BrowserError("invalid_params", `${key} 必须是有界字符串`);
  }
  const need = action === "attach" || action === "open" ? ["url"] : ["click", "check", "uncheck"].includes(action) ? ["ref"] : action === "fill" ? ["ref", "text"] : action === "select" ? ["ref", "value"] : action === "press" ? ["key"] : action === "scroll" ? ["direction"] : action === "tabs" ? ["operation"] : [];
  for (const key of need) if (typeof input[key] !== "string") throw new BrowserError("invalid_params", `动作 ${action} 需要 ${key}`);
  if (input.ref !== undefined && !/^@e\d+$/.test(String(input.ref))) throw new BrowserError("invalid_params", "使用当前 snapshot 返回的 @e 引用");
  if (action === "open" || (action === "tabs" && input.url !== undefined)) {
    let url: URL;
    try { url = new URL(String(input.url)); }
    catch { throw new BrowserError("invalid_params", "网页 URL 无法解析"); }
    if (!["http:", "https:"].includes(url.protocol)) throw new BrowserError("invalid_params", "网页 URL 只支持 http/https");
  }
  if (action === "scroll" && !["up", "down", "left", "right"].includes(String(input.direction))) throw new BrowserError("invalid_params", "滚动方向无效");
  for (const [key, max] of [["pixels", 100_000], ["ms", 25_000], ["index", 10_000]] as const) {
    if (input[key] !== undefined && (!Number.isInteger(input[key]) || Number(input[key]) < 0 || Number(input[key]) > max)) throw new BrowserError("invalid_params", `${key} 必须是 0–${max} 的整数`);
  }
  if (action === "wait" && input.ms === undefined) throw new BrowserError("invalid_params", "wait 需要 ms");
  if (input.full !== undefined && typeof input.full !== "boolean") throw new BrowserError("invalid_params", "full 必须是布尔值");
  if (action === "tabs") {
    if (!["list", "new", "switch", "close"].includes(String(input.operation))) throw new BrowserError("invalid_params", "标签动作无效");
    if (["switch", "close"].includes(String(input.operation)) && input.index === undefined) throw new BrowserError("invalid_params", "标签动作需要 index");
    if (input.operation !== "new" && input.url !== undefined) throw new BrowserError("invalid_params", "只有新标签可传 url");
    if (["list", "new"].includes(String(input.operation)) && input.index !== undefined) throw new BrowserError("invalid_params", "此标签动作不接受 index");
  }
  return input as BrowserParams;
}

export function browserCommandArgs(p: BrowserParams): string[] {
  return p.action === "snapshot" ? ["snapshot", "-i"] : p.action === "open" ? ["open", p.url!] : p.action === "fill" ? ["fill", p.ref!, p.text!] : p.action === "select" ? ["select", p.ref!, p.value!] : p.action === "press" ? ["press", p.key!] : p.action === "scroll" ? ["scroll", p.direction!, String(p.pixels ?? 500)] : p.action === "wait" ? ["wait", String(p.ms)] : p.action === "tabs" ? p.operation === "switch" ? ["tab", String(p.index)] : ["tab", p.operation!, ...(p.index !== undefined ? [String(p.index)] : p.url ? [p.url] : [])] : [p.action, p.ref!];
}
