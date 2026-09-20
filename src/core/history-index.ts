/**
 * 历史条目位置索引与原文检索（issue 05 §2）。
 *
 * - pi JSONL 仍是消息历史的唯一权威副本；本索引只记录条目元数据与字节
 *   位置（可重建的派生数据），不复制消息正文；
 * - 增量更新按已完整落盘的换行记录处理；尾部部分记录不入索引；完整记录
 *   损坏明确报错（history_corrupt）；
 * - 文件身份（dev+ino+路径）与已处理位置记录在 history_index_state；文件
 *   替换/截断/索引缺失时重建派生索引，不覆盖源文件；
 * - 搜索为字面关键词匹配（中文按原文），在授权范围内依据索引定位原文并
 *   扫描；有扫描上限，未扫完如实返回 complete=false。
 */

import * as fs from "node:fs";
import type { Db } from "./db.ts";
import { HistoryReadError, type ParsedSessionEntry } from "./history.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "./types.ts";

export interface IndexedEntry {
  sessionId: string;
  entryId: string;
  parentId: string | null;
  role: string | null;
  entryType: string;
  timestamp: string | null;
  byteOffset: number;
  byteLength: number;
}

export interface IndexSyncResult {
  sessionId: string;
  /** 本次新入索引的条目数。 */
  added: number;
  /** 是否发生了重建（文件替换/截断/索引缺失）。 */
  rebuilt: boolean;
  /** 尾部存在未换行的部分记录（未入索引）。 */
  hasPartialTail: boolean;
  /** 已处理字节位置（= 已完整落盘部分的长度）。 */
  processedBytes: number;
}

export class HistoryIndex {
  constructor(private readonly db: Db) {}

  /**
   * 同步一个会话文件的索引（增量；必要时重建）。
   * 完整行损坏抛 HistoryReadError(history_corrupt)，索引保持损坏前状态。
   */
  sync(sessionId: string, filePath: string): IndexSyncResult {
    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      // 文件尚未落盘：不是错误，也不是"没有历史"
      return { sessionId, added: 0, rebuilt: false, hasPartialTail: false, processedBytes: 0 };
    }
    const state = this.getState(sessionId);
    const sameFile =
      state !== null && state.filePath === filePath && state.fileDev === st.dev && state.fileIno === st.ino;
    const canResume = sameFile && st.size >= state.processedBytes;

    if (!canResume) {
      // 文件替换/截断/索引缺失：重建派生索引（只动索引，不碰源文件）
      this.db.prepare("DELETE FROM history_index WHERE session_id = ?").run(sessionId);
      return this.scan(sessionId, filePath, st, 0, true);
    }
    if (st.size === state.processedBytes) {
      return { sessionId, added: 0, rebuilt: false, hasPartialTail: this.hasPartialTail(filePath, st.size), processedBytes: state.processedBytes };
    }
    return this.scan(sessionId, filePath, st, state.processedBytes, false);
  }

  /** 从 offset 起扫描完整行并写入索引；返回处理位置。 */
  private scan(sessionId: string, filePath: string, st: fs.Stats, offset: number, rebuilt: boolean): IndexSyncResult {
    const fd = fs.openSync(filePath, "r");
    let added = 0;
    let processed = offset;
    let hasPartialTail = false;
    try {
      const buf = Buffer.alloc(st.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      let pos = 0;
      const insert = this.db.prepare(
        `INSERT INTO history_index (session_id, entry_id, parent_id, role, entry_type, timestamp, byte_offset, byte_length)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, entry_id) DO NOTHING`,
      );
      while (pos < buf.length) {
        const nl = buf.indexOf(0x0a, pos);
        if (nl === -1) {
          hasPartialTail = pos < buf.length;
          break;
        }
        const line = buf.subarray(pos, nl).toString("utf8");
        const lineStart = offset + pos;
        const lineLen = nl - pos + 1;
        pos = nl + 1;
        processed = offset + pos;
        if (line.trim().length === 0) continue;
        let entry: ParsedSessionEntry;
        try {
          entry = JSON.parse(line) as ParsedSessionEntry;
        } catch (err) {
          throw new HistoryReadError("history_corrupt", `会话文件第 ${lineStart} 字节处记录解析失败：${(err as Error).message}`);
        }
        if (typeof entry.type !== "string" || typeof entry.id !== "string") {
          throw new HistoryReadError("history_corrupt", `会话文件第 ${lineStart} 字节处记录缺少 type/id 字段`);
        }
        const message = entry.message as Record<string, unknown> | undefined;
        insert.run(
          sessionId,
          entry.id,
          typeof entry.parentId === "string" ? entry.parentId : null,
          message && typeof message.role === "string" ? message.role : null,
          entry.type,
          typeof entry.timestamp === "string" ? entry.timestamp : null,
          lineStart,
          lineLen,
        );
        added++;
      }
    } finally {
      fs.closeSync(fd);
    }
    this.db
      .prepare(
        `INSERT INTO history_index_state (session_id, file_path, file_dev, file_ino, processed_bytes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET file_path = excluded.file_path, file_dev = excluded.file_dev,
           file_ino = excluded.file_ino, processed_bytes = excluded.processed_bytes, updated_at = excluded.updated_at`,
      )
      .run(sessionId, filePath, st.dev, st.ino, processed, new Date().toISOString());
    return { sessionId, added, rebuilt, hasPartialTail, processedBytes: processed };
  }

  private hasPartialTail(filePath: string, size: number): boolean {
    if (size === 0) return false;
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  }

  getState(sessionId: string): { filePath: string; fileDev: number; fileIno: number; processedBytes: number } | null {
    const row = this.db.prepare("SELECT * FROM history_index_state WHERE session_id = ?").get(sessionId) as any;
    if (!row) return null;
    return {
      filePath: row.file_path,
      fileDev: Number(row.file_dev),
      fileIno: Number(row.file_ino),
      processedBytes: Number(row.processed_bytes),
    };
  }

  /** 会话是否已建立索引（区分"没有结果"与"尚未扫描"）。 */
  isIndexed(sessionId: string): boolean {
    return this.getState(sessionId) !== null;
  }

  getEntry(sessionId: string, entryId: string): IndexedEntry | null {
    const row = this.db
      .prepare("SELECT * FROM history_index WHERE session_id = ? AND entry_id = ?")
      .get(sessionId, entryId) as any;
    return row ? rowToIndexed(row) : null;
  }

  listEntries(sessionId: string): IndexedEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM history_index WHERE session_id = ? ORDER BY byte_offset")
      .all(sessionId) as any[];
    return rows.map(rowToIndexed);
  }
}

function rowToIndexed(row: any): IndexedEntry {
  return {
    sessionId: row.session_id,
    entryId: row.entry_id,
    parentId: row.parent_id,
    role: row.role,
    entryType: row.entry_type,
    timestamp: row.timestamp,
    byteOffset: Number(row.byte_offset),
    byteLength: Number(row.byte_length),
  };
}

// ---------- 原文读取与搜索 ----------

/** 按索引位置从 JSONL 读取单条原始记录（解析为结构化条目）。 */
export function readRawEntryAt(filePath: string, offset: number, length: number): ParsedSessionEntry {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, offset);
    const line = buf.toString("utf8").replace(/\n$/, "");
    try {
      return JSON.parse(line) as ParsedSessionEntry;
    } catch (err) {
      throw new HistoryReadError("history_corrupt", `条目原文解析失败（偏移 ${offset}）：${(err as Error).message}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** 提取条目的可搜索文本（消息正文 + 工具调用参数 + 工具结果文本）。 */
export function entrySearchText(entry: ParsedSessionEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message) return "";
  const parts: string[] = [];
  const content = message.content;
  const pushContent = (c: unknown): void => {
    if (typeof c === "string") {
      parts.push(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const p = part as Record<string, unknown>;
        if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
        else if ((p?.type === "toolCall" || p?.type === "tool_use" || p?.type === "tool-call") && p.arguments !== undefined) {
          try {
            parts.push(JSON.stringify(p.arguments));
          } catch {
            // 忽略不可序列化参数
          }
        }
      }
    }
  };
  pushContent(content);
  return parts.join("\n");
}

export interface HistorySearchHit {
  sessionId: string;
  entryId: string;
  parentId: string | null;
  role: string | null;
  timestamp: string | null;
  /** 命中片段（关键词前后各 contextChars 字符，UTF-8 安全）。 */
  snippet: string;
  /** 该条目内命中次数（上限内统计）。 */
  matchCount: number;
}

export interface HistorySearchOptions {
  /** 字面关键词（必填，非空）。 */
  query: string;
  /** 限定任务（按任务边界标记推导字节范围；只搜该任务所在会话的该段）。 */
  taskId?: string;
  /** 角色过滤（user/assistant/toolResult…）。 */
  role?: string;
  /** 时间范围（ISO 字符串，闭区间）。 */
  since?: string;
  until?: string;
  /** 命中数上限（默认 20，最大 100）。 */
  limit?: number;
  /** 单次扫描的条目数上限（默认 2000，最大 20000）。 */
  scanLimit?: number;
  /** 继续游标：上一页最后一个被扫描条目的 (sessionId, byteOffset)。 */
  cursor?: { sessionId: string; byteOffset: number };
  /** 片段上下文字符数（默认 80）。 */
  contextChars?: number;
}

export interface HistorySearchResult {
  hits: HistorySearchHit[];
  /** false = 达到扫描上限，结果不完整（cursor 可继续）。 */
  complete: boolean;
  /** 继续游标；complete=true 时为 null。 */
  cursor: { sessionId: string; byteOffset: number } | null;
  /** 本次扫描的条目数。 */
  scanned: number;
}

/**
 * 由任务边界标记（custom 条目）推导任务在会话文件中的字节范围。
 * 返回 null = 该会话中没有此任务的标记；end=null = 任务没有结束标记
 * （崩溃/中断），范围延伸到文件末尾或下一任务起点。
 */
export function findTaskByteRange(
  db: Db,
  filePath: string,
  sessionId: string,
  taskId: string,
): { start: number; end: number | null } | null {
  const rows = db
    .prepare(
      `SELECT byte_offset, byte_length FROM history_index
       WHERE session_id = ? AND entry_type = 'custom' ORDER BY byte_offset`,
    )
    .all(sessionId) as any[];
  let start: number | null = null;
  let end: number | null = null;
  for (const row of rows) {
    let raw: ParsedSessionEntry;
    try {
      raw = readRawEntryAt(filePath, Number(row.byte_offset), Number(row.byte_length));
    } catch {
      continue;
    }
    const data = (raw as any).data as Record<string, unknown> | undefined;
    if (data?.taskId !== taskId) continue;
    const customType = (raw as any).customType;
    if (customType === TASK_START_MARKER && start === null) {
      start = Number(row.byte_offset);
    } else if (customType === TASK_END_MARKER && start !== null) {
      end = Number(row.byte_offset);
      break;
    }
  }
  if (start === null) return null;
  return { start, end };
}

const SNIPPET_MAX_BYTES = 1024;

/**
 * 在指定会话集合内做字面关键词搜索。调用方负责范围过滤（只传入有权读取
 * 的会话）；本函数不判断权限。
 */
export function searchHistory(
  db: Db,
  sessions: Array<{ sessionId: string; filePath: string }>,
  opts: HistorySearchOptions,
): HistorySearchResult {
  const query = opts.query;
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);
  const scanLimit = Math.min(Math.max(1, opts.scanLimit ?? 2000), 20000);
  const contextChars = Math.min(Math.max(0, opts.contextChars ?? 80), 400);

  const hits: HistorySearchHit[] = [];
  let scanned = 0;
  let complete = true;
  let cursor: { sessionId: string; byteOffset: number } | null = null;
  let lastScannedOffset = -1;

  outer: for (const session of sessions) {
    // 游标定位：跳过已扫描部分（同会话内按 byteOffset 续扫）
    let afterOffset =
      opts.cursor && opts.cursor.sessionId === session.sessionId ? opts.cursor.byteOffset : -1;
    // 任务过滤：只扫描该任务标记范围内的条目；会话中没有此任务则跳过
    let beforeOffset = Number.POSITIVE_INFINITY;
    if (opts.taskId) {
      const range = findTaskByteRange(db, session.filePath, session.sessionId, opts.taskId);
      if (!range) continue;
      afterOffset = Math.max(afterOffset, range.start);
      if (range.end !== null) beforeOffset = range.end;
    }
    const rows = db
      .prepare(
        `SELECT * FROM history_index
         WHERE session_id = ? AND entry_type = 'message' AND byte_offset > ? AND byte_offset < ?
         ORDER BY byte_offset`,
      )
      .all(session.sessionId, afterOffset, beforeOffset) as any[];
    for (const row of rows) {
      const entry = rowToIndexed(row);
      if (opts.role && entry.role !== opts.role) continue;
      if (opts.since && (!entry.timestamp || entry.timestamp < opts.since)) continue;
      if (opts.until && (!entry.timestamp || entry.timestamp > opts.until)) continue;
      if (scanned >= scanLimit) {
        complete = false;
        // 游标指向"最后完成扫描的条目"：下轮从它之后继续，不丢不重
        cursor = { sessionId: session.sessionId, byteOffset: lastScannedOffset };
        break outer;
      }
      scanned++;
      lastScannedOffset = entry.byteOffset;
      let raw: ParsedSessionEntry;
      try {
        raw = readRawEntryAt(session.filePath, entry.byteOffset, entry.byteLength);
      } catch {
        continue; // 单条损坏不中断整体搜索；完整行损坏在 sync 时已报错
      }
      const text = entrySearchText(raw);
      if (!text) continue;
      const idx = text.indexOf(query);
      if (idx === -1) continue;
      let matchCount = 0;
      let from = 0;
      while (matchCount < 100) {
        const at = text.indexOf(query, from);
        if (at === -1) break;
        matchCount++;
        from = at + query.length;
      }
      const snippet = snippetAround(text, idx, query.length, contextChars);
      hits.push({
        sessionId: entry.sessionId,
        entryId: entry.entryId,
        parentId: entry.parentId,
        role: entry.role,
        timestamp: entry.timestamp,
        snippet,
        matchCount,
      });
      if (hits.length >= limit) {
        // 命中数已满：游标指向当前条目（已扫描），下轮从它之后继续
        complete = false;
        cursor = { sessionId: session.sessionId, byteOffset: entry.byteOffset };
        break outer;
      }
    }
  }
  return { hits, complete, cursor, scanned };
}

function snippetAround(text: string, matchIndex: number, matchLength: number, contextChars: number): string {
  const start = Math.max(0, matchIndex - contextChars);
  const end = Math.min(text.length, matchIndex + matchLength + contextChars);
  let snippet = text.slice(start, end);
  // 片段字节上限（防御超长行）
  if (Buffer.byteLength(snippet, "utf8") > SNIPPET_MAX_BYTES) {
    const buf = Buffer.from(snippet, "utf8");
    snippet = buf.subarray(0, SNIPPET_MAX_BYTES).toString("utf8");
  }
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}
