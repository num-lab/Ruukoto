import type { ToolResultView } from "@ruukoto/core/history.ts";
import type { FlowEntry } from "@ruukoto/view/event-flow.ts";

export type DiffTool = Extract<FlowEntry, { kind: "tool" }>;
export interface PatchLine { kind: "header" | "hunk" | "added" | "removed" | "context" | "notice"; text: string; number?: number }
export type DiffDisplay = { kind: "status" | "error" | "effect_unknown" | "unavailable" | "patch" | "write"; text: string; truncated: boolean };

export function isDiffTool(tool: DiffTool): boolean { return tool.name.toLowerCase() === "edit" || tool.name.toLowerCase() === "write"; }
export function canReadDiff(tool: DiffTool): boolean { return tool.status !== "running" && tool.entryId !== null; }

// Note: See .agents/notes/proposed/architecture/2026-10-15-desktop-client.md
export function diffDisplay(tool: DiffTool, result?: ToolResultView): DiffDisplay {
  const display = (kind: DiffDisplay["kind"], text: string): DiffDisplay => ({ kind, text, truncated: result?.truncated ?? false });
  if (tool.status === "running") return display("status", "Running");
  if (tool.status === "effect_unknown") return display("effect_unknown", result?.text || tool.summary || "Outcome unknown");
  if (tool.status === "error" || result?.isError === true) return display("error", result?.text || tool.summary || "Failed; details unavailable");
  if (!tool.entryId) return display("status", "Waiting for the result to persist");
  if (!result) return display("status", "Loading result…");
  if (result.isError !== false) return display("unavailable", "Diff unavailable");
  const content = tool.name.toLowerCase() === "edit" ? result.patch : result.writeContent;
  if (content === null || content === undefined) return display("unavailable", "Diff unavailable");
  return display(tool.name.toLowerCase() === "edit" ? "patch" : "write", content);
}

export function parsePatch(patch: string): PatchLine[] {
  let inHunk = false;
  let oldLine = 0, newLine = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(text => {
    if (text.startsWith("@@")) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (range) { oldLine = Number(range[1]); newLine = Number(range[2]); }
      inHunk = !!range;
      return { kind: "hunk", text };
    }
    if (text.startsWith("diff ")) inHunk = false;
    const kind = inHunk ? text.startsWith("+") ? "added" : text.startsWith("-") ? "removed" : text.startsWith(" ") ? "context" : "notice" : "header";
    const number = kind === "added" ? newLine++ : kind === "removed" ? oldLine++ : kind === "context" ? (oldLine++, newLine++) : undefined;
    return { kind, text, ...(number === undefined ? {} : { number }) };
  });
}
