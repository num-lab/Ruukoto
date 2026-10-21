import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "@ruukoto/core/db.ts";
import { HistoryIndex } from "@ruukoto/core/history-index.ts";
import { HistoryReadError } from "@ruukoto/core/history.ts";
import { readIndexedHistoryEntryText, readIndexedHistoryPage } from "@ruukoto/core/history-window.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";

const message = (id: string, text = id) => JSON.stringify({ type: "message", id, parentId: null, timestamp: `2026-10-21T00:00:00Z`, message: { role: "assistant", content: text } });
const marker = (id: string, start: boolean, taskId: string) => JSON.stringify({ type: "custom", id, customType: start ? TASK_START_MARKER : TASK_END_MARKER, data: { taskId } });

function fixture(lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-history-window-"));
  const db = new Db(dir);
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const index = new HistoryIndex(db);
  index.sync("session", file);
  return { db, file, index, close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("索引历史窗口：越过最新 300 条直接围绕目标，双向续页覆盖固定语料且不重不漏", () => {
  const ids = Array.from({ length: 450 }, (_, i) => `entry-${i}`);
  const f = fixture(ids.map(id => message(id)));
  try {
    const around = readIndexedHistoryPage(f.db, "session", f.file, { around: ids[25], limit: 7 });
    assert.deepEqual(around.entries.map(entry => entry.entryId), ids.slice(22, 29));
    assert.equal(around.nextBefore, ids[22]);
    assert.equal(around.nextAfter, ids[28]);
    assert.ok(around.source);
    const all = [...around.entries.map(entry => entry.entryId)];
    let before: string | null = around.nextBefore;
    while (before) {
      const page = readIndexedHistoryPage(f.db, "session", f.file, { before, source: around.source!, limit: 11 });
      all.unshift(...page.entries.map(entry => entry.entryId));
      before = page.nextBefore;
    }
    let after: string | null = around.nextAfter;
    while (after) {
      const page = readIndexedHistoryPage(f.db, "session", f.file, { after, source: around.source!, limit: 19 });
      all.push(...page.entries.map(entry => entry.entryId));
      after = page.nextAfter;
    }
    assert.deepEqual(all, ids);
    for (const target of [ids[0], ids.at(-1)!]) {
      const page = readIndexedHistoryPage(f.db, "session", f.file, { around: target, limit: 7 });
      assert.equal(page.entries.length, 7);
      assert.ok(page.entries.some(entry => entry.entryId === target));
    }
  } finally { f.close(); }
});

test("索引历史窗口：预算缩小附近范围仍保留超长目标，中文分片连续且追加保持来源", () => {
  const big = "汉字🙂".repeat(100_000);
  const f = fixture([message("before", "x".repeat(256)), marker("start", true, "task"), message("target", big), marker("end", false, "task"), message("after", "y".repeat(256))]);
  try {
    const page = readIndexedHistoryPage(f.db, "session", f.file, { around: "target", entryTextCap: 257, pageTextBudget: 257 });
    assert.deepEqual(page.entries.map(entry => entry.entryId), ["target"]);
    assert.equal(page.entries[0].taskId, "task");
    assert.equal(page.entries[0].truncated, true);
    assert.equal(page.nextBefore, "target");
    assert.equal(page.nextAfter, "target");
    let text = "";
    let offset = 0;
    while (offset < Buffer.byteLength(big)) {
      const entry = readIndexedHistoryEntryText(f.db, "session", f.file, "target", offset, 65_533, page.source!);
      assert.equal(entry.offset, offset);
      assert.equal(entry.totalBytes, Buffer.byteLength(big));
      assert.equal(entry.text.includes("\uFFFD"), false);
      assert.equal(entry.taskId, "task");
      text += entry.text;
      offset += Buffer.byteLength(entry.text);
    }
    assert.equal(text, big);
    fs.appendFileSync(f.file, message("appended") + "\n");
    f.index.sync("session", f.file);
    const next = readIndexedHistoryPage(f.db, "session", f.file, { after: "target", source: page.source! });
    assert.deepEqual(next.entries.map(entry => [entry.entryId, entry.taskId]), [["after", null], ["appended", null]]);
    assert.equal(next.source, page.source);
  } finally { f.close(); }
});

test("索引历史窗口：损坏、缺目标、方向互斥、来源替换与截短分别明确失败", () => {
  const f = fixture([message("one"), message("two")]);
  const fails = (read: () => unknown, code: HistoryReadError["code"]) => assert.throws(read, (error: unknown) => error instanceof HistoryReadError && error.code === code);
  try {
    const page = readIndexedHistoryPage(f.db, "session", f.file, { around: "one" });
    fails(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "missing" }), "entry_not_found");
    for (const opts of [{ around: "one", before: "two" }, { before: "one", after: "two" }, { around: "one", after: "two" }]) fails(() => readIndexedHistoryPage(f.db, "session", f.file, opts), "invalid_params");
    fails(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "one", source: "invalid" }), "cursor_invalid");
    fs.renameSync(f.file, `${f.file}.old`);
    fs.writeFileSync(f.file, message("one") + "\n");
    f.index.sync("session", f.file);
    fails(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "one", source: page.source! }), "history_changed");
    const replacement = readIndexedHistoryPage(f.db, "session", f.file, { around: "one" });
    fs.truncateSync(f.file, 0);
    f.index.sync("session", f.file);
    fails(() => readIndexedHistoryEntryText(f.db, "session", f.file, "one", 0, 1024, replacement.source!), "history_changed");
    fs.writeFileSync(f.file, message("one") + "\n");
    f.index.sync("session", f.file);
    fs.writeFileSync(f.file, "x");
    fails(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "one" }), "history_changed");
    fs.writeFileSync(f.file, message("one") + "\n");
    f.index.sync("session", f.file);
    const fd = fs.openSync(f.file, "r+");
    try { fs.writeSync(fd, "x", 0); } finally { fs.closeSync(fd); }
    fails(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "one" }), "history_corrupt");
  } finally { f.close(); }
});

test("索引历史窗口：任务标记损坏不猜归属，部分尾行不成为消息", () => {
  const f = fixture([marker("start", true, "first"), message("one"), marker("end", false, "other"), message("two")]);
  try {
    assert.throws(() => readIndexedHistoryPage(f.db, "session", f.file, { around: "two" }), (error: unknown) => error instanceof HistoryReadError && error.code === "history_corrupt");
    fs.writeFileSync(f.file, message("one") + '\n{"type":"message","id":"partial"');
    f.index.sync("session", f.file);
    const page = readIndexedHistoryPage(f.db, "session", f.file, { around: "one" });
    assert.deepEqual(page.entries.map(entry => entry.entryId), ["one"]);
    assert.equal(page.hasPartialTail, true);
  } finally { f.close(); }
});
