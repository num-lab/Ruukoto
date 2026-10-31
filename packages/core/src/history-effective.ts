/**
 * Effective history applies context_edit omissions to physically parsed records for model input and default display.
 * Original JSONL bytes, IDs, order and parent links remain unchanged.
 * The contract matches Pi 1.3.0 SessionManager contributions without a runtime SDK dependency.
 * Edits may target only earlier editable contributions: user/assistant/toolResult messages or custom_message.
 * Only null replacements are supported; invalid references, replacements and targets raise history_corrupt.
 * Note: See .agents/notes/implemented/feature/2026-10-30-coding-message-recall.md
 */

import { HistoryReadError, parseSessionFileStrict, type ParsedSessionEntry } from "./history.ts";

/** Recall completion marker: an ordinary custom record, not a model contribution. */
export const MESSAGE_RECALL_MARKER = "ruukoto_message_recall";

/** Whether an entry is an editable model contribution, matching SDK appendContextEdit eligibility. */
export function isEditableContribution(entry: ParsedSessionEntry): boolean {
  if (entry.type === "custom_message") return true;
  if (entry.type !== "message") return false;
  const role = (entry.message as { role?: unknown } | undefined)?.role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

export interface EffectiveProjection {
  /** All physically parsed entries, including context_edit and custom markers. */
  entries: ParsedSessionEntry[];
  /** Contribution IDs omitted by their latest null edit. */
  omitted: Set<string>;
  /** Effective model contributions in original order, excluding context_edit and custom records. */
  contributions: ParsedSessionEntry[];
}

/**
 * Validate edit targets and return editable contributions not omitted by edits; custom records are not contributions.
 */
export function effectiveProjection(entries: ParsedSessionEntry[]): EffectiveProjection {
  const seen = new Map<string, ParsedSessionEntry>();
  const edits = new Map<string, { replacement: unknown }>();
  for (const entry of entries) {
    if (entry.type !== "context_edit") {
      seen.set(entry.id, entry);
      continue;
    }
    const targetId = (entry as { targetId?: unknown }).targetId;
    if (typeof targetId !== "string" || !seen.has(targetId)) {
      throw new HistoryReadError("history_corrupt", `context_edit ${entry.id} 引用未知或更晚的条目`);
    }
    const target = seen.get(targetId)!;
    if (!isEditableContribution(target)) {
      throw new HistoryReadError("history_corrupt", `context_edit ${entry.id} 目标 ${targetId} 不是可编辑贡献`);
    }
    const replacement = (entry as { replacement?: unknown }).replacement;
    if (replacement !== null) {
      throw new HistoryReadError("history_corrupt", `context_edit ${entry.id} 使用不支持的替换格式，保留原档案待核实`);
    }
    edits.set(targetId, { replacement });
  }
  const omitted = new Set<string>();
  for (const [targetId, edit] of edits) {
    if (edit.replacement === null) omitted.add(targetId);
  }
  const contributions = entries.filter((entry) => isEditableContribution(entry) && !omitted.has(entry.id));
  return { entries, omitted, contributions };
}

/** Omission IDs for pagination and search filtering. */
export function omittedEntryIds(entries: ParsedSessionEntry[]): Set<string> {
  return effectiveProjection(entries).omitted;
}

/**
 * Materialize effective history for independent branches and side chats without rewriting the source.
 * Preserve entry IDs, discard omitted contributions and context_edit records, and reconnect parent links in the copy.
 * throughEntryId fixes the original selection boundary, but omissions are computed from the entire prefix, including edits appended after that boundary.
 */
export function materializeEffectiveHistory(prefix: Buffer, opts: { throughEntryId?: string } = {}): Buffer {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch {
    throw new HistoryReadError("history_corrupt", "来源历史前缀不是合法 UTF-8");
  }
  const { entries } = parseSessionFileStrict(text);
  const { omitted } = effectiveProjection(entries);
  const lines: string[] = [];
  let parent: string | null = null;
  let reached = opts.throughEntryId === undefined;
  for (const entry of entries) {
    if (entry.type !== "context_edit" && !omitted.has(entry.id)) {
      // The session header is outside the parent chain; retain it without advancing the initial null parent.
      lines.push(entry.type === "session" ? JSON.stringify(entry) : JSON.stringify({ ...entry, parentId: parent }));
      if (entry.type !== "session") parent = entry.id;
    }
    if (entry.id === opts.throughEntryId) { reached = true; break; }
  }
  if (!reached) throw new HistoryReadError("history_corrupt", "来源历史前缀缺少固定的选择边界条目");
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}
