import type { ToolResultView } from "@ruukoto/core/history.ts";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";

export type DiffTool = Extract<FlowEntry, { kind: "tool" }>;
export interface PatchLine { kind: "header" | "hunk" | "added" | "removed" | "context" | "notice"; text: string }
export type DiffDisplay = { kind: "status" | "error" | "effect_unknown" | "unavailable" | "patch" | "write"; text: string; truncated: boolean };

export function isDiffTool(tool: DiffTool): boolean { return tool.name.toLowerCase() === "edit" || tool.name.toLowerCase() === "write"; }
export function canReadDiff(tool: DiffTool): boolean { return tool.status !== "running" && tool.entryId !== null; }

// Note: 见 .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export function diffDisplay(tool: DiffTool, result?: ToolResultView): DiffDisplay {
  const display = (kind: DiffDisplay["kind"], text: string): DiffDisplay => ({ kind, text, truncated: result?.truncated ?? false });
  if (tool.status === "running") return display("status", "运行中");
  if (tool.status === "effect_unknown") return display("effect_unknown", result?.text || tool.summary || "效果未知");
  if (tool.status === "error" || result?.isError === true) return display("error", result?.text || tool.summary || "失败，详情不可用");
  if (!tool.entryId) return display("status", "等待结果落盘");
  if (!result) return display("status", "正在读取结果…");
  if (result.isError !== false) return display("unavailable", "差异不可用");
  const content = tool.name.toLowerCase() === "edit" ? result.patch : result.writeContent;
  if (content === null || content === undefined) return display("unavailable", "差异不可用");
  return display(tool.name.toLowerCase() === "edit" ? "patch" : "write", content);
}

export function parsePatch(patch: string): PatchLine[] {
  let inHunk = false;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(text => {
    if (text.startsWith("@@")) { inHunk = true; return { kind: "hunk", text }; }
    if (text.startsWith("diff ")) inHunk = false;
    const kind = inHunk ? text.startsWith("+") ? "added" : text.startsWith("-") ? "removed" : text.startsWith(" ") ? "context" : "notice" : "header";
    return { kind, text };
  });
}
