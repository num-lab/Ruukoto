type Fields = Record<string, unknown>;

function fields(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON 的层级保留为缩进，字符串里的换行直接展示。 */
function readable(value: unknown, indent = "", key = ""): string[] {
  if (/^(?:base64|.*signature|encrypted_content)$/i.test(key) || key === "data" && typeof value === "string" && /^[A-Za-z0-9+/=\s]{128,}$/.test(value)) return [`${indent}（二进制或签名内容已省略）`];
  if (Array.isArray(value)) return value.length
    ? value.flatMap((item, i) => [`${indent}${i + 1}.`, ...readable(item, `${indent}  `)])
    : [`${indent}（空）`];
  if (fields(value)) return Object.entries(value).flatMap(([name, item]) =>
    fields(item) || Array.isArray(item) || typeof item === "string" && item.includes("\n")
      ? [`${indent}${name}:`, ...readable(item, `${indent}  `, name)]
      : readable(item, "", name).map((line) => `${indent}${name}: ${line}`));
  const text = value === null ? "无" : String(value);
  return (/^data:[^,]*;base64,/i.test(text) ? ["（图片或二进制内容已省略）"] : text.split("\n")).map((line) => indent + line);
}

function extra(value: Fields, omitted: string[]): string[] {
  return readable(Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key))));
}

function content(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((part) => [...content(part), ""]);
  if (!fields(value)) return readable(value);
  switch (value.type) {
    case "text": return [...readable(value.text ?? ""), ...extra(value, ["type", "text"])];
    case "thinking": return ["思考", ...readable(value.thinking ?? "", "  "), ...extra(value, ["type", "thinking"])];
    case "toolCall": return [`工具调用 · ${value.name ?? "未知工具"}`, ...readable(value.arguments ?? {}, "  "), ...extra(value, ["type", "name", "arguments"])];
    case "image": return [`图片 · ${value.mimeType ?? "未知类型"}（图片内容已省略）`, ...extra(value, ["type", "mimeType", "data", "base64"])];
    default: return readable(value);
  }
}

/** 把模型输入快照呈现为正文；解析失败交给窗口显示错误，不展示 JSON 原文。 */
export function formatPromptSnapshot(raw: string): string {
  let snapshot: unknown;
  try { snapshot = JSON.parse(raw); }
  catch { throw new Error("Prompt 快照无法解析：JSON 无效或内容不完整"); }
  if (!fields(snapshot)) throw new Error("Prompt 快照格式无效：应为对象");
  const lines = ["调用信息", ...readable(Object.fromEntries(Object.entries(snapshot).filter(([key]) => !["systemPrompt", "messages", "tools"].includes(key)))), "", "系统提示", ...content(snapshot.systemPrompt ?? ""), "", "消息"];
  if (Array.isArray(snapshot.messages)) {
    const roles: Record<string, string> = { user: "用户", assistant: "助手", system: "系统", toolResult: "工具结果" };
    snapshot.messages.forEach((message, index) => {
      if (!fields(message)) { lines.push(...readable(message), ""); return; }
      const role = String(message.role ?? "未知角色");
      lines.push(`${index + 1}. ${roles[role] ?? role}${message.toolName ? ` · ${message.toolName}` : ""}`, ...content(message.content ?? ""), ...extra(message, ["role", "content", "toolName"]), "");
    });
  } else if (snapshot.messages !== undefined) lines.push(...readable(snapshot.messages));
  lines.push("工具定义");
  if (Array.isArray(snapshot.tools)) {
    snapshot.tools.forEach((tool) => {
      if (!fields(tool)) { lines.push(...readable(tool), ""); return; }
      lines.push(String(tool.name ?? "未知工具"), ...readable(tool.description ?? ""), "参数", ...readable(tool.parameters ?? {}, "  "), ...extra(tool, ["name", "description", "parameters"]), "");
    });
  } else if (snapshot.tools !== undefined) lines.push(...readable(snapshot.tools));
  return lines.join("\n").trimEnd();
}
