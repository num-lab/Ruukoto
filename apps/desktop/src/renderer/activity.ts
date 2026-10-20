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
    timeline: groups.filter(group => !(group[0].kind === "thinking" && !group[0].text.trim() && group.length === 1 && group !== thinkingBatch)),
    activeKey: (batch ?? thinkingBatch)?.[0].key,
    groups: groups.filter(group => group !== batch && group !== thinkingBatch && !(group[0].kind === "thinking" && !group[0].text.trim() && group.length === 1)),
    phase: batch ? "working" as const : thinking ? "thinking" as const : null,
    tools: batch?.filter((item): item is DiffTool => item.kind === "tool") ?? [],
    thinking: (batch ?? thinkingBatch)?.find((item): item is Extract<FlowEntry, { kind: "thinking" }> => item.kind === "thinking"),
  };
}

type ActivityPhase = "thinking" | "working";
export interface ConversationSection { key: string; taskId?: string; groups: FlowEntry[][]; trace: boolean; completed: boolean; tailPhase?: ActivityPhase }

// Note: 见 .agents/notes/implemented/feature/2026-10-18-completed-trace.md
export function conversationSections(view: ViewState, items: FlowEntry[], groups: FlowEntry[][], tail?: { taskId: string; phase: ActivityPhase }, historyReady: (taskId: string) => boolean = () => true): ConversationSection[] {
  const latest = new Map<string, FlowEntry>();
  for (const item of items) if (item.taskId && (item.kind === "tool" || item.kind === "thinking" || item.kind === "message" && (item.text.trim() || item.attachments?.length))) latest.set(item.taskId, item);
  const finalIds = new Map<string, string>();
  const approvals = new Set(view.pendingApprovals().map(approval => approval.taskId));
  for (const [taskId, item] of latest) if (historyReady(taskId) && view.tasks.get(taskId)?.status === "completed" && !approvals.has(taskId) && item.kind === "message" && item.role === "assistant" && item.entryId && !item.streaming && item.text.trim()) finalIds.set(taskId, item.entryId);
  const sections: ConversationSection[] = [];
  for (const group of groups) {
    const item = group[0];
    if (!["tool", "thinking", "message"].includes(item.kind) && !(item.kind === "task" && item.task.errorMessage)) continue;
    const final = item.taskId && item.kind === "message" && item.role === "assistant" && item.entryId === finalIds.get(item.taskId);
    const activity = item.kind === "tool" || item.kind === "thinking";
    const partOfRun = !final && (activity || item.kind === "message" && item.role === "assistant" && !!item.taskId);
    const previous = sections.at(-1);
    if (partOfRun && previous && previous.taskId === item.taskId && previous.trace && item.taskId) previous.groups.push(group);
    else sections.push({ key: partOfRun ? `${item.taskId ?? item.key}:trace:${previous?.groups.at(-1)?.at(-1)?.key ?? "start"}` : item.key, taskId: item.taskId, groups: [group], trace: partOfRun, completed: !!item.taskId && finalIds.has(item.taskId) });
  }
  if (tail) {
    const previous = sections.at(-1);
    if (previous?.trace && previous.taskId === tail.taskId) previous.tailPhase = tail.phase;
    else sections.push({ key: `${tail.taskId}:trace:${previous?.groups.at(-1)?.at(-1)?.key ?? "start"}`, taskId: tail.taskId, groups: [], trace: true, completed: false, tailPhase: tail.phase });
  }
  return sections;
}


export function executionDuration(startedAt: string | null | undefined, endedAt: string | null | undefined): string | undefined {
  if (!startedAt || !endedAt) return undefined;
  const elapsed = Date.parse(endedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return undefined;
  const seconds = Math.round(elapsed / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
