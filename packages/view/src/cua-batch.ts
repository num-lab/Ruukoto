/** run_steps 审批参数的可读步骤摘要（浏览器安全）；TUI 与桌面审批共用，原始参数仍需逐页展示。 */

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 解析后的 run_steps 参数 → 有序步骤行；无法识别时返回 null，调用方退回原始 JSON 展示。 */
export function cuaBatchSummary(params: unknown): string[] | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const object = params as Record<string, unknown>;
  if (!Array.isArray(object.steps) || object.steps.length === 0) return null;
  const lines: string[] = [];
  for (const [index, raw] of object.steps.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const step = raw as Record<string, unknown>;
    const tool = typeof step.tool === "string" ? step.tool : "?";
    const args = step.args && typeof step.args === "object" && !Array.isArray(step.args) ? step.args as Record<string, unknown> : {};
    const target = typeof args.element_token === "string" ? `元素 ${args.element_token}`
      : typeof args.role === "string" || typeof args.name === "string" || typeof args.label === "string" ? `${args.role ?? "元素"} "${args.name ?? args.label ?? ""}"`
      : args.x !== undefined || args.y !== undefined ? `坐标 (${args.x ?? "?"}, ${args.y ?? "?"})`
      : args.from_x !== undefined ? `坐标 (${args.from_x}, ${args.from_y}) → (${args.to_x}, ${args.to_y})`
      : "焦点目标";
    const input = typeof args.text === "string" ? `文本 ${JSON.stringify(truncate(args.text, 40))}`
      : typeof args.value === "string" ? `值 ${JSON.stringify(truncate(args.value, 40))}`
      : typeof args.key === "string" ? `键 ${args.key}${Array.isArray(args.modifiers) ? ` +${(args.modifiers as string[]).join("+")}` : ""}`
      : Array.isArray(args.keys) ? `键 ${(args.keys as string[]).join("+")}`
      : typeof args.direction === "string" ? `方向 ${args.direction}${typeof args.amount === "number" ? ` ×${args.amount}` : ""}`
      : typeof args.action === "string" ? `动作 ${args.action}` : "";
    const delivery = typeof args.delivery_mode === "string" ? args.delivery_mode : "";
    lines.push(`${index + 1}. ${tool} · ${target}${input ? ` · ${input}` : ""}${delivery ? ` · ${delivery}` : ""}`);
  }
  if (typeof object.delay_ms === "number" && object.delay_ms > 0) lines.push(`步间延迟 ${object.delay_ms}ms`);
  lines.push(`批次窗口 pid ${object.pid ?? "?"} · window_id ${object.window_id ?? "?"}${typeof object.delivery_mode === "string" ? ` · 默认 ${object.delivery_mode}` : ""}`);
  lines.push(`末尾观察：${JSON.stringify(object.observe ?? {})}`);
  return lines;
}
