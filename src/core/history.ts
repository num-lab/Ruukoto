/**
 * 会话历史读取：pi JSONL 会话文件的分页与分段读取（后台共用模块）。
 *
 * - pi JSONL 是消息历史的唯一权威副本；本模块只读，不建第二份历史；
 * - 控制面（04 TUI 历史查看）与 05 的历史检索工具共用这里的读取边界；
 * - 分页固定本次读取的末端位置（before 游标 = 条目 ID），后续追加经事件
 *   获取，翻页不会因新写入而重复或跳过消息；
 * - 严格解析：完整行损坏即报错（history_corrupt），不静默跳过；文件尾部
 *   未换行的行视为正在写入的部分记录（hasPartialTail），不伪装成完整消息；
 * - 超大单条消息按字节分段读取，偏移对齐 UTF-8 字符边界（顺序翻页拼接
 *   不会出现乱码）。
 */

import * as fs from "node:fs";
import type { BoundedText } from "./views.ts";
import type { EditStats } from "./types.ts";

/** Buffer 内 index 处的 UTF-8 起始对齐：续字节向后落到字符边界。 */
export function snapUtf8Start(buf: Buffer, index: number): number {
  let i = Math.min(Math.max(0, index), buf.length);
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** Buffer 内 index 处的 UTF-8 结束对齐：切在字符中间则回退。 */
export function snapUtf8End(buf: Buffer, index: number): number {
  let i = Math.min(Math.max(0, index), buf.length);
  while (i > 0 && i < buf.length && (buf[i]! & 0xc0) === 0x80) i--;
  return i;
}

export class HistoryReadError extends Error {
  readonly code: "history_corrupt" | "entry_not_found";
  constructor(code: "history_corrupt" | "entry_not_found", message: string) {
    super(message);
    this.code = code;
  }
}

export interface ParsedSessionEntry {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface ParsedSessionFile {
  entries: ParsedSessionEntry[];
  /** 尾部存在未换行结束的行（写入进行中）；该行不包含在 entries 内。 */
  hasPartialTail: boolean;
}

/**
 * 严格解析 JSONL 会话文件。完整行（以 \n 结束）解析失败即抛
 * HistoryReadError(history_corrupt)；尾部未换行的行作为部分记录排除。
 */
export function parseSessionFileStrict(text: string): ParsedSessionFile {
  const hasPartialTail = text.length > 0 && !text.endsWith("\n");
  const lines = text.split("\n");
  if (hasPartialTail) lines.pop();
  const entries: ParsedSessionEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    let entry: ParsedSessionEntry;
    try {
      entry = JSON.parse(line) as ParsedSessionEntry;
    } catch (err) {
      throw new HistoryReadError(
        "history_corrupt",
        `会话文件第 ${i + 1} 行解析失败：${(err as Error).message}`,
      );
    }
    if (typeof entry.type !== "string" || typeof entry.id !== "string") {
      throw new HistoryReadError("history_corrupt", `会话文件第 ${i + 1} 行缺少 type/id 字段`);
    }
    entries.push(entry);
  }
  return { entries, hasPartialTail };
}

/** 从磁盘读取并严格解析会话文件。 */
export function parseSessionFile(file: string): ParsedSessionEntry[] {
  return parseSessionFileStrict(fs.readFileSync(file, "utf8")).entries;
}

// ---------- 历史条目视图 ----------

export interface HistoryToolCallRef {
  toolCallId: string;
  toolName: string;
}

export interface HistoryEntryView {
  entryId: string;
  parentId: string | null;
  role: string;
  timestamp: string;
  /** 本次返回的正文片段（UTF-8 文本）。 */
  text: string;
  /** 片段在完整正文中的起始字节偏移。 */
  offset: number;
  /** 完整正文的字节数。 */
  totalBytes: number;
  /** true = 正文未完整返回，经 readHistoryEntryText 分段补齐。 */
  truncated: boolean;
  /** assistant 消息携带的工具调用关联。 */
  toolCalls: HistoryToolCallRef[];
  /** toolResult 消息的工具关联。 */
  toolCallId: string | null;
  toolName: string | null;
  isError: boolean | null;
  editStats?: EditStats;
  /** 内容含图片/思考等未内联展示的部分。 */
  hasNonTextContent: boolean;
}

/** 从实际 unified patch 统计变更行，不计上下文与文件头。 */
export function statsFromPatch(patch: string): EditStats {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) inHunk = true;
    else if (line.startsWith("diff ") || line.startsWith("Index: ")) inHunk = false;
    else if (inHunk && line.startsWith("+")) added++;
    else if (inHunk && line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Edit 读取实际补丁；Write 读取工作进程在写入时计算的小型统计。 */
export function editStatsFromResult(toolName: unknown, isError: unknown, details: unknown): EditStats | undefined {
  if (isError !== false || !details || typeof details !== "object") return undefined;
  if (toolName === "write") {
    const stats = (details as { editStats?: EditStats }).editStats;
    if (!stats || !Number.isSafeInteger(stats.added) || stats.added < 0 || !Number.isSafeInteger(stats.removed) || stats.removed < 0) return undefined;
    return { added: stats.added, removed: stats.removed };
  }
  if (toolName !== "edit") return undefined;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" ? statsFromPatch(patch) : undefined;
}

function extractMessageView(entry: ParsedSessionEntry): { text: string; view: Omit<HistoryEntryView, "text" | "offset" | "totalBytes" | "truncated"> } | null {
  if (entry.type !== "message") return null;
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message.role !== "string") return null;
  const role = message.role;
  const content = message.content;
  const textParts: string[] = [];
  const toolCalls: HistoryToolCallRef[] = [];
  let hasNonTextContent = false;
  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p?.type === "text" && typeof p.text === "string") {
        textParts.push(p.text);
      } else if (p?.type === "toolCall" || p?.type === "tool_use" || p?.type === "tool-call") {
        const id = typeof p.id === "string" ? p.id : typeof p.toolCallId === "string" ? p.toolCallId : null;
        const name = typeof p.name === "string" ? p.name : typeof p.toolName === "string" ? p.toolName : null;
        if (id && name) toolCalls.push({ toolCallId: id, toolName: name });
        hasNonTextContent = true;
      } else {
        hasNonTextContent = true;
      }
    }
  } else if (content !== undefined && content !== null) {
    hasNonTextContent = true;
  }
  const toolResult = role === "toolResult";
  const editStats = toolResult ? editStatsFromResult(message.toolName, message.isError, message.details) : undefined;
  return {
    text: textParts.join(""),
    view: {
      entryId: entry.id,
      parentId: typeof entry.parentId === "string" ? entry.parentId : null,
      role,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
      toolCalls,
      toolCallId: toolResult && typeof message.toolCallId === "string" ? message.toolCallId : null,
      toolName: toolResult && typeof message.toolName === "string" ? message.toolName : null,
      isError: toolResult && typeof message.isError === "boolean" ? message.isError : null,
      hasNonTextContent,
      ...(editStats ? { editStats } : {}),
    },
  };
}

/** 把文本按字节偏移切片，起止对齐 UTF-8 字符边界（顺序拼接不乱码）。 */
export function sliceTextByBytes(text: string, offset: number, length: number): BoundedText {
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;
  const start = snapUtf8Start(buf, offset);
  const end = snapUtf8End(buf, Math.min(start + Math.max(0, length), totalBytes));
  const slice = buf.subarray(start, end).toString("utf8");
  return { text: slice, offset: start, totalBytes, truncated: end < totalBytes || start > 0 };
}

/** 保留文本尾部 cap 字节（运行中预览用：最新输出在末尾），起点对齐字符边界。 */
export function tailTextByBytes(
  text: string,
  cap: number,
): { text: string; totalBytes: number; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  const totalBytes = buf.length;
  if (totalBytes <= cap) return { text, totalBytes, truncated: false };
  const start = snapUtf8Start(buf, totalBytes - cap);
  return { text: buf.subarray(start).toString("utf8"), totalBytes, truncated: true };
}

export interface ReadHistoryPageOptions {
  /** 只返回严格早于该条目的消息（翻页游标）；省略 = 最新一页。 */
  before?: string;
  /** 条目数上限（默认 50，最大 200）。 */
  limit?: number;
  /** 单条正文内联上限（字节，默认 16 KiB）；超出部分经 readHistoryEntryText 分段读取。 */
  entryTextCap?: number;
  /** 整页正文总字节预算（默认 192 KiB）；保证至少返回 1 条。 */
  pageTextBudget?: number;
}

export interface HistoryPage {
  /** false = 会话文件尚未首次落盘（不是错误，也不是损坏）。 */
  fileAvailable: boolean;
  /** 尾部有正在写入的部分记录。 */
  hasPartialTail: boolean;
  /** 消息条目（旧 → 新）。 */
  entries: HistoryEntryView[];
  /** 向前（更老）翻页游标；null = 没有更老的条目。 */
  nextBefore: string | null;
}

/**
 * 分页读取会话历史（只含 message 条目；宿主标记等 custom 条目不属于消息历史）。
 * before 固定本次读取的末端：返回严格早于 before 的一页；省略时返回最新一页。
 */
export function readHistoryPage(sessionFile: string | null, opts: ReadHistoryPageOptions = {}): HistoryPage {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    return { fileAvailable: false, hasPartialTail: false, entries: [], nextBefore: null };
  }
  const { entries, hasPartialTail } = parseSessionFileStrict(fs.readFileSync(sessionFile, "utf8"));
  const messages = entries.filter((e) => e.type === "message");
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const entryTextCap = Math.min(Math.max(256, opts.entryTextCap ?? 16 * 1024), 256 * 1024);
  const pageTextBudget = Math.min(Math.max(entryTextCap, opts.pageTextBudget ?? 192 * 1024), 1024 * 1024);

  let endExclusive = messages.length;
  if (opts.before !== undefined) {
    const idx = messages.findIndex((e) => e.id === opts.before);
    if (idx === -1) {
      throw new HistoryReadError("entry_not_found", `历史条目不存在：${opts.before}`);
    }
    endExclusive = idx;
  }

  // 从末端向前收集，直到条目数与字节预算耗尽（至少 1 条）
  const picked: Array<{ entry: ParsedSessionEntry; extracted: NonNullable<ReturnType<typeof extractMessageView>> }> = [];
  let budget = pageTextBudget;
  for (let i = endExclusive - 1; i >= 0 && picked.length < limit; i--) {
    const extracted = extractMessageView(messages[i]!);
    if (!extracted) continue;
    const bytes = Math.min(Buffer.byteLength(extracted.text, "utf8"), entryTextCap);
    if (picked.length > 0 && bytes > budget) break;
    budget -= bytes;
    picked.push({ entry: messages[i]!, extracted });
  }
  picked.reverse();

  const views = picked.map(({ extracted }) => {
    const slice = sliceTextByBytes(extracted.text, 0, entryTextCap);
    return { ...extracted.view, ...slice };
  });
  const firstPickedIdx = picked.length > 0 ? messages.indexOf(picked[0]!.entry) : endExclusive;
  const nextBefore = picked.length > 0 && firstPickedIdx > 0 ? picked[0]!.entry.id : null;
  return { fileAvailable: true, hasPartialTail, entries: views, nextBefore };
}

/**
 * 读取指定条目的正文分段（字节偏移，UTF-8 边界对齐）。
 * 顺序翻页：下一次 offset = 本次 offset + Buffer.byteLength(text)。
 */
export function readHistoryEntryText(
  sessionFile: string | null,
  entryId: string,
  offset = 0,
  length = 64 * 1024,
): HistoryEntryView {
  if (!sessionFile || !fs.existsSync(sessionFile)) {
    throw new HistoryReadError("entry_not_found", `会话文件尚未落盘，条目不可读：${entryId}`);
  }
  const { entries } = parseSessionFileStrict(fs.readFileSync(sessionFile, "utf8"));
  const entry = entries.find((e) => e.id === entryId && e.type === "message");
  if (!entry) throw new HistoryReadError("entry_not_found", `历史条目不存在：${entryId}`);
  const extracted = extractMessageView(entry)!;
  const cap = Math.min(Math.max(256, length), 256 * 1024);
  const slice = sliceTextByBytes(extracted.text, offset, cap);
  return { ...extracted.view, ...slice };
}
