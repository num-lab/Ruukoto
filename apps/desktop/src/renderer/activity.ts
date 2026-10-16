import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { ViewState } from "@ruukoto/view/state.ts";
import type { DiffTool } from "./diff.ts";

export function isAgentTool(tool: DiffTool): boolean { return tool.name === "subagent_delegate"; }
export function activityGroups(items: FlowEntry[]): FlowEntry[][] {
  const groups: FlowEntry[][] = [];
  for (const item of items) {
    const last = groups.at(-1)?.at(-1);
    if (item.kind === "tool" && !isAgentTool(item) && last?.kind === "tool" && !isAgentTool(last) && item.taskId === last.taskId) groups.at(-1)!.push(item);
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
export function conversationActivity(view: ViewState, sessionId: string, online: boolean) {
  const session = view.openSession(sessionId);
  const groups = activityGroups(session.flow.items);
  const task = view.activeTaskFor(sessionId);
  const running = online && task?.status === "running" && !task.cancelRequested && session.queueState !== "paused" && !view.pendingApprovals().some(approval => approval.sessionId === sessionId);
  const batch = running ? groups.findLast(group => group.some(item => item.kind === "tool" && item.taskId === task.id && item.status === "running")) : undefined;
  const thinking = running && !batch && session.flow.items.some(item => item.kind === "thinking" && item.taskId === task.id && item.endedAt === null);
  return {
    groups: groups.filter(group => group !== batch && group[0].kind !== "thinking" && !(group[0].kind === "message" && !group[0].text.trim() && !group[0].attachments?.length)),
    phase: batch ? "working" as const : thinking ? "thinking" as const : null,
    tools: batch?.filter((item): item is DiffTool => item.kind === "tool") ?? [],
  };
}
