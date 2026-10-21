import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Db } from "./db.ts";
import { extractMessageView, HistoryReadError } from "./history.ts";
import { HISTORY_INDEX_BATCH_BYTES, HistoryIndex, readRawEntryAt, type HistorySearchHit } from "./history-index.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "./types.ts";

export interface WorkspaceHistoryCandidate {
  sessionId: string;
  filePath: string | null;
  historyExpected: boolean;
  excludedEntryIds?: ReadonlySet<string>;
  excludedTaskIds?: ReadonlySet<string>;
}

export interface WorkspaceHistoryCursor {
  phase: "index" | "scan";
  sessionId: string;
  byteOffset: number;
  readOffset: number;
  source: { fileDev: number; fileIno: number; minSize: number };
  queryKey: string;
}

export interface WorkspaceHistorySearchOptions {
  query: string;
  limit?: number;
  scanLimit?: number;
  contextChars?: number;
  role?: string;
  since?: string;
  until?: string;
  cursor?: WorkspaceHistoryCursor | { sessionId: string; byteOffset: number } | null;
}

export interface WorkspaceHistorySourceIssue {
  sessionId: string;
  code: "history_pending" | "history_missing" | "history_unreadable" | "history_corrupt";
}

export interface WorkspaceHistorySearchResult {
  hits: HistorySearchHit[];
  complete: boolean;
  cursor: WorkspaceHistoryCursor | null;
  scanned: number;
  unindexedSessionIds: string[];
  sourceIssues: WorkspaceHistorySourceIssue[];
  progress: { indexedBytes: number; scannedBytes: number };
}

const PAGE_BYTES = 1024 * 1024;
const PAGE_MS = 35;
const ROW_BATCH = 128;

function sourceStat(candidate: WorkspaceHistoryCandidate, index: HistoryIndex): fs.Stats {
  if (!candidate.filePath) throw new HistoryReadError(candidate.historyExpected || index.isIndexed(candidate.sessionId) ? "history_missing" : "entry_not_found", "会话历史尚不可读");
  try {
    const stat = fs.statSync(candidate.filePath);
    if (!stat.isFile()) throw new HistoryReadError("history_corrupt", "会话历史来源不是文件");
    return stat;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new HistoryReadError(candidate.historyExpected || index.isIndexed(candidate.sessionId) ? "history_missing" : "entry_not_found", "会话历史文件不存在");
    if (err instanceof HistoryReadError) throw err;
    throw new HistoryReadError("history_unreadable", "会话历史无法读取，请核实来源后重试");
  }
}

function asciiFold(value: string): string {
  if (!/[A-Z]/.test(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  for (let at = 0; at < bytes.length; at++) if (bytes[at] >= 65 && bytes[at] <= 90) bytes[at] += 32;
  return bytes.toString("utf8");
}

function snippet(text: string, at: number, length: number, context: number): string {
  let start = Math.max(0, at - context);
  let end = Math.min(text.length, at + length + context);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** 分批读取普通聊天；候选资格由宿主决定，来源问题逐页返回，由查询控制器累计。 */
// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
export async function searchWorkspaceHistory(db: Db, candidates: readonly WorkspaceHistoryCandidate[], opts: WorkspaceHistorySearchOptions): Promise<WorkspaceHistorySearchResult> {
  if (!opts.query) throw new HistoryReadError("invalid_params", "搜索关键词不能为空");
  const ordered = [...candidates].sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0);
  const queryKey = createHash("sha256").update(JSON.stringify([opts.query, opts.role, opts.since, opts.until, ordered.map(candidate => [candidate.sessionId, candidate.filePath])])).digest("hex");
  const supplied = opts.cursor;
  let candidateIndex = supplied ? ordered.findIndex(candidate => candidate.sessionId === supplied.sessionId) : 0;
  if (candidateIndex < 0 || supplied && "phase" in supplied && supplied.queryKey !== queryKey) throw new HistoryReadError("cursor_invalid", "搜索条件或会话范围已改变，请重新搜索");
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const scanLimit = Math.min(Math.max(opts.scanLimit ?? 2000, 1), 20000);
  const context = Math.min(Math.max(opts.contextChars ?? 80, 0), 400);
  const needle = asciiFold(opts.query);
  const index = new HistoryIndex(db);
  const result: WorkspaceHistorySearchResult = { hits: [], complete: true, cursor: null, scanned: 0, unindexedSessionIds: [], sourceIssues: [], progress: { indexedBytes: 0, scannedBytes: 0 } };
  const began = performance.now();
  let phase = supplied && "phase" in supplied ? supplied.phase : supplied ? "scan" : "index";
  let byteOffset = supplied?.byteOffset ?? -1;
  let readOffset = supplied && "readOffset" in supplied ? supplied.readOffset : undefined;
  let progressed = false;
  const budgetUsed = () => progressed && (performance.now() - began >= PAGE_MS || result.progress.indexedBytes + result.progress.scannedBytes >= PAGE_BYTES || result.scanned >= scanLimit || result.hits.length >= limit);

  for (; candidateIndex < ordered.length; candidateIndex++) {
    const candidate = ordered[candidateIndex];
    let stat: fs.Stats;
    try {
      stat = sourceStat(candidate, index);
    } catch (err) {
      if (supplied?.sessionId === candidate.sessionId) throw new HistoryReadError("history_changed", "搜索游标的历史来源已不可读，请重新搜索");
      if (!(err instanceof HistoryReadError)) throw err;
      const code = err.code === "entry_not_found" ? "history_pending" : err.code;
      if (code !== "history_missing" && code !== "history_unreadable" && code !== "history_pending" && code !== "history_corrupt") throw err;
      result.sourceIssues.push({ sessionId: candidate.sessionId, code });
      if (code === "history_pending") result.unindexedSessionIds.push(candidate.sessionId);
      phase = "index"; byteOffset = -1; readOffset = undefined; progressed = true;
      await setImmediate();
      continue;
    }
    if (supplied?.sessionId === candidate.sessionId && "source" in supplied) {
      const state = index.getState(candidate.sessionId);
      if (stat.dev !== supplied.source.fileDev || stat.ino !== supplied.source.fileIno || stat.size < supplied.source.minSize || state && state.filePath !== candidate.filePath) throw new HistoryReadError("history_changed", "搜索游标的历史来源已改变，请重新搜索");
    }
    const makeCursor = (): WorkspaceHistoryCursor => ({ phase, sessionId: candidate.sessionId, byteOffset, readOffset: readOffset ?? index.getState(candidate.sessionId)?.processedBytes ?? 0,
      source: { fileDev: stat.dev, fileIno: stat.ino, minSize: stat.size }, queryKey });
    const verifySource = (): void => {
      let current: fs.Stats;
      try { current = sourceStat(candidate, index); }
      catch { throw new HistoryReadError("history_changed", "历史来源在搜索期间已不可读，请重新搜索"); }
      if (current.dev !== stat.dev || current.ino !== stat.ino || current.size < stat.size) throw new HistoryReadError("history_changed", "历史来源在搜索期间改变，请重新搜索");
    };
    const stop = (): WorkspaceHistorySearchResult => {
      verifySource();
      result.complete = false; result.cursor = makeCursor(); return result;
    };
    try {
      if (supplied?.sessionId === candidate.sessionId && "phase" in supplied) {
        const state = index.getState(candidate.sessionId);
        if (!state || supplied.readOffset > stat.size || supplied.phase === "index" && supplied.byteOffset !== -1) throw new HistoryReadError("cursor_invalid", "搜索索引进度无效，请重新搜索");
        if (supplied.phase === "scan" && supplied.byteOffset >= 0) {
          const row = db.prepare("SELECT byte_length FROM history_index WHERE session_id = ? AND byte_offset = ? LIMIT 1").get(candidate.sessionId, supplied.byteOffset);
          if (!row || supplied.byteOffset + Number(row.byte_length) > Math.min(state.processedBytes, stat.size)) throw new HistoryReadError("cursor_invalid", "搜索扫描位置已失效，请重新搜索");
        }
        if (supplied.phase === "index" && supplied.readOffset > state.processedBytes) {
          const fd = fs.openSync(candidate.filePath!, "r");
          try {
            const bytes = Buffer.alloc(HISTORY_INDEX_BATCH_BYTES);
            for (let at = state.processedBytes; at < supplied.readOffset;) {
              const length = Math.min(bytes.length, supplied.readOffset - at);
              const count = fs.readSync(fd, bytes, 0, length, at);
              if (count !== length || bytes.subarray(0, count).includes(0x0a)) throw new HistoryReadError("cursor_invalid", "搜索索引进度跨过了未登记完整记录，请重新搜索");
              at += count;
              await setImmediate();
            }
          } finally { fs.closeSync(fd); }
          verifySource();
        }
      }
      while (phase === "index") {
        const batch = index.syncBatch(candidate.sessionId, candidate.filePath!, readOffset);
        result.progress.indexedBytes += batch.bytesRead;
        readOffset = batch.readOffset;
        progressed ||= batch.bytesRead > 0;
        if (batch.complete) {
          phase = "scan";
          if (batch.hasPartialTail) {
            result.sourceIssues.push({ sessionId: candidate.sessionId, code: "history_pending" });
            result.unindexedSessionIds.push(candidate.sessionId);
          }
        }
        await setImmediate();
        verifySource();
        if (budgetUsed()) return stop();
      }
      let taskId: string | null = null;
      if (byteOffset >= 0) {
        let endedTask: string | null = null;
        const markers = db.prepare("SELECT byte_offset, byte_length FROM history_index WHERE session_id = ? AND entry_type = 'custom' AND byte_offset <= ? ORDER BY byte_offset DESC").iterate(candidate.sessionId, byteOffset);
        for (const row of markers) {
          const marker = readRawEntryAt(candidate.filePath!, Number(row.byte_offset), Number(row.byte_length));
          if (marker.customType === TASK_START_MARKER || marker.customType === TASK_END_MARKER) {
            const marked = (marker.data as { taskId?: unknown } | undefined)?.taskId;
            if (typeof marked !== "string" || !marked || endedTask !== null && (marker.customType !== TASK_START_MARKER || marked !== endedTask)) throw new HistoryReadError("history_corrupt", "历史任务标记无法配对，请核实会话记录");
            if (endedTask !== null) break;
            if (marker.customType === TASK_END_MARKER) { endedTask = marked; continue; }
            taskId = marked;
            break;
          }
        }
      }
      for (;;) {
        const rows = db.prepare("SELECT entry_id, byte_offset, byte_length, entry_type, role, timestamp FROM history_index WHERE session_id = ? AND byte_offset > ? ORDER BY byte_offset LIMIT ?").all(candidate.sessionId, byteOffset, ROW_BATCH);
        if (!rows.length) break;
        for (const row of rows) {
          if (budgetUsed()) return stop();
          const raw = readRawEntryAt(candidate.filePath!, Number(row.byte_offset), Number(row.byte_length));
          if (raw.id !== row.entry_id || raw.type !== row.entry_type) throw new HistoryReadError("history_changed", "历史原文与位置索引不一致，请重新搜索");
          byteOffset = Number(row.byte_offset);
          result.progress.scannedBytes += Number(row.byte_length);
          progressed = true;
          if (raw.type === "custom" && (raw.customType === TASK_START_MARKER || raw.customType === TASK_END_MARKER)) {
            const marked = (raw.data as { taskId?: unknown } | undefined)?.taskId;
            if (typeof marked !== "string" || !marked || raw.customType === TASK_END_MARKER && marked !== taskId) throw new HistoryReadError("history_corrupt", "历史任务标记无法配对，请核实会话记录");
            taskId = raw.customType === TASK_START_MARKER ? marked : null;
          }
          if (raw.type !== "message") continue;
          result.scanned++;
          if (row.role !== "user" && row.role !== "assistant" || opts.role && row.role !== opts.role || opts.since && (!row.timestamp || String(row.timestamp) < opts.since) || opts.until && (!row.timestamp || String(row.timestamp) > opts.until) || row.role === "user" && (candidate.excludedEntryIds?.has(String(row.entry_id)) || taskId && candidate.excludedTaskIds?.has(taskId))) continue;
          const extracted = extractMessageView(raw, taskId);
          const text = extracted?.text ?? "";
          const folded = asciiFold(text);
          const at = folded.indexOf(needle);
          if (at < 0) continue;
          let matchCount = 0;
          for (let from = at; from >= 0 && matchCount < 100; from = folded.indexOf(needle, from + needle.length)) matchCount++;
          result.hits.push({ sessionId: candidate.sessionId, entryId: raw.id, parentId: extracted!.view.parentId, role: extracted!.view.role, timestamp: extracted!.view.timestamp, snippet: snippet(text, at, needle.length, context), matchCount });
        }
        await setImmediate();
      }
      verifySource();
    } catch (err) {
      const systemCode = (err as NodeJS.ErrnoException).code;
      if (typeof (err as NodeJS.ErrnoException).syscall === "string") {
        if (systemCode === "ENOENT" && supplied?.sessionId === candidate.sessionId) throw new HistoryReadError("history_changed", "搜索游标的历史来源已丢失，请重新搜索");
        result.sourceIssues.push({ sessionId: candidate.sessionId, code: systemCode === "ENOENT" ? "history_missing" : "history_unreadable" });
      } else {
        if (!(err instanceof HistoryReadError) || err.code !== "history_corrupt") throw err;
        result.sourceIssues.push({ sessionId: candidate.sessionId, code: "history_corrupt" });
      }
    }
    phase = "index"; byteOffset = -1; readOffset = undefined; progressed = true;
    await setImmediate();
  }
  return result;
}
