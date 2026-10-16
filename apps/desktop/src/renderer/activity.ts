import type { FlowEntry } from "@ruukoto/view/event-flow.ts";
import type { DiffTool } from "./diff.ts";

export function isAgentTool(tool: DiffTool): boolean { return tool.name === "subagent_delegate"; }
export function activityGroups(items: FlowEntry[]): FlowEntry[][] {
  const groups: FlowEntry[][] = [];
  for (const item of items) {
    const last = groups.at(-1)?.at(-1);
    if (item.kind === "tool" && !isAgentTool(item) && last?.kind === "tool" && !isAgentTool(last)) groups.at(-1)!.push(item);
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
export function toolLabel(name: string): string {
  return ({ edit: "Edited", write: "Write", read: "Read" } as Record<string, string>)[name.toLowerCase()] ?? name;
}
