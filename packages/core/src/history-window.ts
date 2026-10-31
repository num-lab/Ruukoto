import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { Db } from "./db.ts";
import { HistoryIndex, omittedEntryIdsForSession } from "./history-index.ts";
import { extractMessageView, HistoryReadError, sliceTextByBytes, type HistoryEntryView, type HistoryPage, type ParsedSessionEntry, type ReadHistoryPageOptions } from "./history.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "./types.ts";

interface Position { entryId: string; byteOffset: number; byteLength: number }
interface Marker { position: Position; taskId: string; start: boolean }
export interface IndexedHistoryPage extends HistoryPage { nextAfter: string | null; source: string | null }

function fileRead<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof HistoryReadError) throw error;
    throw new HistoryReadError(error instanceof Error && "code" in error && error.code === "ENOENT" ? "history_missing" : "history_unreadable", "会话历史无法读取，请核实来源后重新搜索。");
  }
}

function positionRows(db: Db, sessionId: string, type: string, offset: number, newer: boolean, limit: number): Position[] {
  const rows = db.prepare(`SELECT entry_id, byte_offset, byte_length FROM history_index WHERE session_id = ? AND entry_type = ? AND byte_offset ${newer ? ">" : "<"} ? ORDER BY byte_offset ${newer ? "ASC" : "DESC"} LIMIT ?`).all(sessionId, type, offset, limit) as Array<{ entry_id: string; byte_offset: number; byte_length: number }>;
  return rows.map(row => ({ entryId: row.entry_id, byteOffset: Number(row.byte_offset), byteLength: Number(row.byte_length) }));
}

class IndexedReader {
  readonly source: string;
  readonly hasPartialTail: boolean;
  private readonly stat: fs.Stats;
  private readonly minimumBytes: number;
  private readonly markers = new Map<string, Marker | null>();
  /** Omitted entries are absent from default windows and cannot be located by old cursors. */
  private readonly omitted: Set<string>;

  constructor(private readonly db: Db, private readonly sessionId: string, private readonly file: string, private readonly fd: number, source?: string) {
    this.stat = fileRead(() => fs.fstatSync(fd));
    const state = new HistoryIndex(db).getState(sessionId);
    if (!this.stat.isFile() || !state || state.filePath !== file || state.fileDev !== this.stat.dev || state.fileIno !== this.stat.ino || state.processedBytes > this.stat.size) throw new HistoryReadError("history_changed", "历史位置索引与来源不一致，请重新搜索。");
    const identity = createHash("sha256").update(JSON.stringify([file, this.stat.dev, this.stat.ino])).digest("hex");
    this.source = source ?? `${state.processedBytes}:${identity}`;
    const parsed = /^(0|[1-9]\d*):([a-f0-9]{64})$/.exec(this.source);
    if (!parsed || !Number.isSafeInteger(Number(parsed[1]))) throw new HistoryReadError("cursor_invalid", "历史来源游标无效，请重新搜索。");
    this.minimumBytes = Number(parsed[1]);
    if (parsed[2] !== identity || this.minimumBytes > state.processedBytes) throw new HistoryReadError("history_changed", "历史来源已替换或截短，请重新搜索。");
    const tail = Buffer.alloc(1);
    if (this.stat.size) fileRead(() => fs.readSync(fd, tail, 0, 1, this.stat.size - 1));
    this.hasPartialTail = this.stat.size > 0 && tail[0] !== 10;
    this.omitted = omittedEntryIdsForSession(db, sessionId, file);
  }

  verify(): void {
    const current = fileRead(() => fs.statSync(this.file));
    if (current.dev !== this.stat.dev || current.ino !== this.stat.ino || current.size < this.minimumBytes) throw new HistoryReadError("history_changed", "历史来源在读取期间改变，请重新搜索。");
  }

  position(entryId: string): Position {
    const entry = new HistoryIndex(this.db).getEntry(this.sessionId, entryId);
    if (!entry || entry.entryType !== "message" || this.omitted.has(entryId)) throw new HistoryReadError("entry_not_found", "目标历史消息不存在，请重新搜索。");
    return entry;
  }

  neighbors(offset: number, newer: boolean, limit: number): Position[] {
    const picked: Position[] = [];
    let cursor = offset;
    while (picked.length < limit) {
      const want = limit - picked.length;
      const batch = positionRows(this.db, this.sessionId, "message", cursor, newer, want + 32);
      if (!batch.length) break;
      for (const row of batch) {
        cursor = row.byteOffset;
        if (!this.omitted.has(row.entryId)) picked.push(row);
        if (picked.length >= limit) break;
      }
      if (batch.length < want + 32) break;
    }
    return picked;
  }

  raw(position: Position): ParsedSessionEntry {
    const bytes = Buffer.alloc(position.byteLength);
    let read = 0;
    while (read < bytes.length) {
      const count = fileRead(() => fs.readSync(this.fd, bytes, read, bytes.length - read, position.byteOffset + read));
      if (!count) throw new HistoryReadError("history_changed", "历史条目读取不完整，请重新搜索。");
      read += count;
    }
    let entry: ParsedSessionEntry;
    try { entry = JSON.parse(bytes.toString("utf8")) as ParsedSessionEntry; }
    catch { throw new HistoryReadError("history_corrupt", "目标附近的历史记录损坏，请核实会话历史。"); }
    if (!entry || entry.id !== position.entryId || typeof entry.type !== "string") throw new HistoryReadError("history_corrupt", "历史条目与位置索引不一致，请核实会话历史。");
    return entry;
  }

  private markerBefore(offset: number): Marker | null {
    let before = offset;
    for (;;) {
      const positions = positionRows(this.db, this.sessionId, "custom", before, false, 32);
      for (const position of positions) {
        if (!this.markers.has(position.entryId)) {
          const raw = this.raw(position);
          let marker: Marker | null = null;
          if (raw.customType === TASK_START_MARKER || raw.customType === TASK_END_MARKER) {
            const data = raw.data as { taskId?: unknown } | undefined;
            if (typeof data?.taskId !== "string" || !data.taskId) throw new HistoryReadError("history_corrupt", "历史任务标记损坏，请核实会话历史。");
            marker = { position, taskId: data.taskId, start: raw.customType === TASK_START_MARKER };
          }
          this.markers.set(position.entryId, marker);
        }
        const marker = this.markers.get(position.entryId);
        if (marker) return marker;
      }
      if (positions.length < 32) return null;
      before = positions.at(-1)!.byteOffset;
    }
  }

  entry(position: Position, offset: number, length: number): HistoryEntryView {
    const marker = this.markerBefore(position.byteOffset);
    if (marker && !marker.start) {
      const previous = this.markerBefore(marker.position.byteOffset);
      if (!previous?.start || previous.taskId !== marker.taskId) throw new HistoryReadError("history_corrupt", "历史任务结束标记无法配对，请核实会话历史。");
    }
    const extracted = extractMessageView(this.raw(position), marker?.start ? marker.taskId : null);
    if (!extracted) throw new HistoryReadError("history_corrupt", "历史位置没有可读取的消息，请核实会话历史。");
    return { ...extracted.view, ...sliceTextByBytes(extracted.text, offset, length) };
  }
}

function withReader<T>(db: Db, sessionId: string, file: string, source: string | undefined, action: (reader: IndexedReader) => T): T {
  const fd = fileRead(() => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
  try {
    const reader = new IndexedReader(db, sessionId, file, fd, source);
    const result = action(reader);
    reader.verify();
    return result;
  } finally { fs.closeSync(fd); }
}

/** 调用方先准备位置索引；按位置读取连续窗口，来源替换或截短拒绝续读，正常追加保留原来源身份。 */
// Note: 见 .agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md
export function readIndexedHistoryPage(db: Db, sessionId: string, file: string | null, opts: ReadHistoryPageOptions = {}): IndexedHistoryPage {
  if ([opts.before, opts.after, opts.around].filter(value => value !== undefined).length > 1) throw new HistoryReadError("invalid_params", "before、after、around 只能选择一个。");
  if (!file) {
    if (opts.source) throw new HistoryReadError("history_changed", "历史来源已不可用，请重新搜索。");
    if (opts.around !== undefined) throw new HistoryReadError("entry_not_found", "目标历史消息尚未落盘，请稍后重新搜索。");
    return { fileAvailable: false, hasPartialTail: false, entries: [], nextBefore: null, nextAfter: null, source: null };
  }
  return withReader(db, sessionId, file, opts.source, reader => {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const cap = Math.min(Math.max(256, opts.entryTextCap ?? 16 * 1024), 256 * 1024);
    let budget = Math.min(Math.max(cap, opts.pageTextBudget ?? 192 * 1024), 1024 * 1024);
    const picked: Array<{ position: Position; entry: HistoryEntryView }> = [];
    const add = (position: Position, prepend: boolean): boolean => {
      const entry = reader.entry(position, 0, cap);
      const bytes = Buffer.byteLength(entry.text);
      if (picked.length && bytes > budget) return false;
      budget -= bytes;
      const item = { position, entry };
      if (prepend) picked.unshift(item);
      else picked.push(item);
      return true;
    };
    if (opts.around !== undefined) {
      const target = reader.position(opts.around);
      add(target, false);
      const older = reader.neighbors(target.byteOffset, false, limit - 1);
      const newer = reader.neighbors(target.byteOffset, true, limit - 1);
      let left = 0;
      let right = 0;
      let leftOpen = true;
      let rightOpen = true;
      while (picked.length < limit && (leftOpen || rightOpen)) {
        if (leftOpen && picked.length < limit) leftOpen = left < older.length && add(older[left++], true);
        if (rightOpen && picked.length < limit) rightOpen = right < newer.length && add(newer[right++], false);
      }
    } else {
      const newer = opts.after !== undefined;
      const anchor = opts.before ?? opts.after;
      const offset = anchor === undefined ? Number.MAX_SAFE_INTEGER : reader.position(anchor).byteOffset;
      for (const position of reader.neighbors(offset, newer, limit)) if (!add(position, !newer)) break;
    }
    const first = picked[0]?.position;
    const last = picked.at(-1)?.position;
    return { fileAvailable: true, hasPartialTail: reader.hasPartialTail, entries: picked.map(item => item.entry), nextBefore: first && reader.neighbors(first.byteOffset, false, 1).length ? first.entryId : null, nextAfter: last && reader.neighbors(last.byteOffset, true, 1).length ? last.entryId : null, source: reader.source };
  });
}

/** 调用方先准备位置索引；仅读目标 JSONL 行，按 UTF-8 字节补正文，可沿用窗口的来源身份。 */
export function readIndexedHistoryEntryText(db: Db, sessionId: string, file: string | null, entryId: string, offset = 0, length = 64 * 1024, source?: string): HistoryEntryView {
  if (!file) throw new HistoryReadError(source ? "history_changed" : "entry_not_found", "目标历史消息来源不可用，请重新搜索。");
  return withReader(db, sessionId, file, source, reader => reader.entry(reader.position(entryId), offset, Math.min(Math.max(256, length), 256 * 1024)));
}
