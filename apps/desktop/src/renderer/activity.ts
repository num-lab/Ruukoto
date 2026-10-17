import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DiffTool } from "./diff.ts";

export function isAgentTool(tool: DiffTool): boolean { return tool.name === "subagent_delegate"; }
export function activityGroups(items: FlowEntry[]): FlowEntry[][] {
  const groups: FlowEntry[][] = [];
  for (const item of items) {
    const last = groups.at(-1)?.at(-1);
    if (item.kind === "tool" && !isAgentTool(item) && (last?.kind === "thinking" || last?.kind === "tool" && !isAgentTool(last)) && item.taskId === last.taskId) groups.at(-1)!.push(item);
    else groups.push([item]);
  }
  return groups;
}
export function activitySummary(tools: DiffTool[]): string {
  const names = new Set(tools.map(tool => tool.name.toLowerCase()));
  const summary = [
    names.has("read") || names.has("grep") ? "read files" : "",
    names.has("bash") ? "ran commands" : "",
    names.has("edit") ? "edited files" : "",
    names.has("write") ? "wrote files" : "",
  ].filter(Boolean).join(", ");
  return summary ? summary[0].toUpperCase() + summary.slice(1) : "工具活动";
}
// Note: 见 .agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md
// Note: 见 .agents/notes/implemented/bug-fix/2026-10-17-desktop-execution-activity.md
export function conversationActivity(view: ViewState, sessionId: string, online: boolean, items = view.openSession(sessionId).flow.items) {
  const session = view.openSession(sessionId);
  items = items.filter(item => !(item.kind === "message" && !item.text.trim() && !item.attachments?.length));
  const groups = activityGroups(items);
  const task = view.activeTaskFor(sessionId);
  const running = online && task?.status === "running" && !task.cancelRequested && session.queueState !== "paused" && !view.pendingApprovals().some(approval => approval.sessionId === sessionId);
  const batch = running ? groups.findLast(group => group.some(item => item.kind === "tool" && item.taskId === task.id && item.status === "running")) : undefined;
  const latest = running ? items.findLast(item => item.taskId === task.id && ["message", "thinking", "tool"].includes(item.kind)) : undefined;
  const thinking = running && !batch && !(latest?.kind === "message" && latest.role === "assistant" && latest.streaming && latest.text.trim());
  const thinkingBatch = thinking && latest?.kind === "thinking" ? groups.find(group => group.includes(latest)) : undefined;
  return {
    groups: groups.filter(group => group !== batch && group !== thinkingBatch && !(group[0].kind === "thinking" && !group[0].text.trim() && group.length === 1)),
    phase: batch ? "working" as const : thinking ? "thinking" as const : null,
    tools: batch?.filter((item): item is DiffTool => item.kind === "tool") ?? [],
    thinking: (batch ?? thinkingBatch)?.find((item): item is Extract<FlowEntry, { kind: "thinking" }> => item.kind === "thinking"),
  };
}
