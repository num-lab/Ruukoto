/** 只接受每个 SDK 自己的 EventBus 绑定；模块不读取用户或工作区配置。 */
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { SessionHostBinding } from "./session-factory.ts";

export default function hostExtension(pi: ExtensionAPI): void {
  const request: { binding?: SessionHostBinding } = {};
  pi.events.emit("ruukoto:session-host", request);
  if (!request.binding) throw new Error("SDK 缺少宿主绑定，不能加载扩展");
  const { hooks, mcp } = request.binding;
  mcp?.install(pi);
  pi.on("tool_call", async event => hooks.onToolCall(event as ToolCallEvent));
  pi.on("tool_result", async event => {
    const result = event as ToolResultEvent;
    if (result.toolName.startsWith("mcp__") && result.details && typeof result.details === "object" && "ruukotoMcpIsError" in result.details && typeof result.details.ruukotoMcpIsError === "boolean") return { isError: result.details.ruukotoMcpIsError };
    return undefined;
  });
  pi.on("session_before_compact", async () => ({ cancel: true }));
  if (hooks.onContext) pi.on("context_with_system", async event => hooks.onContext!(event.messages));
}
