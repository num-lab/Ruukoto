// 方案调查：仅生成临时合成档案，报告当前检索的分页和耗时，不读取真实历史。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Db } from "@ruukoto/core/db.ts";
import { HistoryIndex, searchHistory } from "@ruukoto/core/history-index.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-spotlight-probe-"));
const db = new Db(dir);
const index = new HistoryIndex(db);
const record = (id, text, role = "user") => ({ type: "message", id, parentId: null, timestamp: "2026-10-21T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
try {
  const pair = ["cursor-a", "cursor-b"].map(sessionId => {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, `${JSON.stringify(record(`${sessionId}-e1`, "needle"))}\n`);
    index.sync(sessionId, filePath);
    return { sessionId, filePath };
  });
  let cursor;
  const pages = [];
  for (let page = 0; page < 5; page++) {
    const result = searchHistory(db, pair, { query: "needle", limit: 1, cursor });
    pages.push({ hits: result.hits.map(hit => hit.entryId), complete: result.complete });
    if (result.complete) break;
    cursor = result.cursor;
  }
  const boundary = searchHistory(db, pair, { query: "absent", scanLimit: 1 });
  const continuation = searchHistory(db, [pair[1]], { query: "needle", cursor: boundary.cursor });
  const text = "合成消息abcdefgh".repeat(32);
  const sessions = [];
  let jsonlBytes = 0;
  for (let number = 0; number < 1000; number++) {
    const sessionId = `perf-${String(number).padStart(4, "0")}`;
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const rows = Array.from({ length: 100 }, (_, item) => record(`${sessionId}-e${item}`, text, item % 2 ? "assistant" : "user"));
    const contents = `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
    jsonlBytes += Buffer.byteLength(contents);
    fs.writeFileSync(filePath, contents);
    sessions.push({ sessionId, filePath });
  }
  const measure = () => {
    const start = performance.now();
    for (const session of sessions) index.sync(session.sessionId, session.filePath);
    const syncMs = performance.now() - start;
    const scanStart = performance.now();
    const result = searchHistory(db, sessions, { query: "___no_such_message___", scanLimit: 2000 });
    const scanMs = performance.now() - scanStart;
    assert.equal(result.scanned, 2000);
    assert.equal(result.complete, false);
    assert.equal(result.hits.length, 0);
    return { syncMs, scanMs, totalMs: syncMs + scanMs };
  };
  const cold = measure();
  const hot = measure();
  assert.equal(index.listEntries(sessions[0].sessionId).length, 100);
  assert.equal(index.listEntries(sessions.at(-1).sessionId).length, 100);
  process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
    cursorPages: pages, boundaryCursor: boundary.cursor, boundaryContinuationHits: continuation.hits.map(hit => hit.entryId),
    sessions: sessions.length, messages: sessions.length * 100, bodyMiB: sessions.length * 100 * Buffer.byteLength(text) / 1048576,
    jsonlMiB: jsonlBytes / 1048576, cold, hot }, null, 2)}\n`);
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
