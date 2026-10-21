import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "@ruukoto/core/db.ts";
import { HISTORY_INDEX_BATCH_BYTES, HistoryIndex, searchHistory } from "@ruukoto/core/history-index.ts";
import { searchWorkspaceHistory, type WorkspaceHistoryCandidate, type WorkspaceHistoryCursor } from "@ruukoto/core/history-search.ts";
import { HistoryReadError } from "@ruukoto/core/history.ts";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";

const record = (id: string, text: string, role = "user") => ({ type: "message", id, parentId: null, timestamp: "2026-10-21T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-history-search-"));
  const db = new Db(dir);
  const index = new HistoryIndex(db);
  const candidate = (sessionId: string, entries: unknown[]): WorkspaceHistoryCandidate => {
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    return { sessionId, filePath, historyExpected: false };
  };
  return { db, index, candidate, close: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("共享搜索：跨会话单条命中、无命中预算边界续页不重不漏且终止", () => {
  const f = fixture();
  try {
    const candidates = ["b", "a", "c"].map(id => f.candidate(id, [record(`${id}1`, "needle"), record(`${id}2`, "needle")]));
    for (const candidate of candidates) f.index.sync(candidate.sessionId, candidate.filePath!);
    for (const limit of [1, 100]) {
      let cursor: { sessionId: string; byteOffset: number } | undefined;
      const hits: string[] = [];
      for (let page = 0; ; page++) {
        assert.ok(page < 12);
        const result = searchHistory(f.db, candidates.map(candidate => ({ sessionId: candidate.sessionId, filePath: candidate.filePath! })), { query: "needle", limit, scanLimit: 1, cursor });
        hits.push(...result.hits.map(hit => hit.entryId));
        if (result.complete) break;
        assert.ok(result.cursor); cursor = result.cursor;
      }
      assert.deepEqual(hits, ["a1", "a2", "b1", "b2", "c1", "c2"]);
    }
    const page = searchHistory(f.db, candidates.map(candidate => ({ sessionId: candidate.sessionId, filePath: candidate.filePath! })), { query: "absent", scanLimit: 2 });
    assert.deepEqual(page.cursor, { sessionId: "a", byteOffset: f.index.getEntry("a", "a2")!.byteOffset });
    assert.throws(() => searchHistory(f.db, [], { query: "needle", cursor: page.cursor! }), HistoryReadError);
  } finally { f.close(); }
});

test("分批索引：首条超过字节预算仍推进，短事务同时登记索引和进度", () => {
  const f = fixture();
  try {
    const c = f.candidate("long", [record("long1", "中文".repeat(HISTORY_INDEX_BATCH_BYTES))]);
    let readOffset: number | undefined;
    for (let batch = 0; ; batch++) {
      const before = readOffset ?? 0;
      const result = f.index.syncBatch(c.sessionId, c.filePath!, readOffset);
      assert.ok(result.bytesRead <= HISTORY_INDEX_BATCH_BYTES);
      assert.ok(result.readOffset > before);
      assert.equal(f.index.getState(c.sessionId)!.processedBytes, result.processedBytes);
      if (result.complete) { assert.equal(result.added, 1); break; }
      assert.equal(f.index.listEntries(c.sessionId).length, 0);
      readOffset = result.readOffset;
      assert.ok(batch < 10);
    }
    assert.equal(f.index.listEntries(c.sessionId).length, 1);
    f.db.faultNextWrite = new Error("injected");
    fs.appendFileSync(c.filePath!, JSON.stringify(record("long2", "next")) + "\n");
    const previous = f.index.getState(c.sessionId)!.processedBytes;
    assert.throws(() => f.index.syncBatch(c.sessionId, c.filePath!), /injected/);
    assert.equal(f.index.getEntry(c.sessionId, "long2"), null);
    assert.equal(f.index.getState(c.sessionId)!.processedBytes, previous);
  } finally { f.close(); }
});

test("普通正文：中文单字、ASCII忽略大小写、展示文本拼接，排除工具与内部回报", async () => {
  const f = fixture();
  try {
    const candidates = [f.candidate("a", [record("a1", "中文Needle"), record("a2", "needle", "toolResult"),
      { type: "custom", id: "start", customType: TASK_START_MARKER, data: { taskId: "internal" } }, record("internal", "needle"), record("internal-summary", "needle", "assistant"),
      { type: "custom", id: "end", customType: TASK_END_MARKER, data: { taskId: "internal" } },
      record("excluded", "needle"), { ...record("a3", ""), message: { role: "assistant", content: [{ type: "text", text: "ne" }, { type: "thinking", thinking: "secret" }, { type: "text", text: "edle" }, { type: "toolCall", arguments: { command: "secret" } }] } }]), f.candidate("b", [record("b1", "needle")])];
    candidates[0].excludedEntryIds = new Set(["excluded", "internal-summary"]); candidates[0].excludedTaskIds = new Set(["internal"]);
    let cursor: WorkspaceHistoryCursor | undefined;
    const found: string[] = [];
    for (let page = 0; ; page++) {
      assert.ok(page < 20);
      const result = await searchWorkspaceHistory(f.db, candidates, { query: "NEEDLE", limit: 1, scanLimit: 1, cursor });
      found.push(...result.hits.map(hit => hit.entryId));
      if (result.complete) break;
      assert.ok(result.cursor); cursor = result.cursor;
    }
    assert.deepEqual(found, ["a1", "internal-summary", "a3", "b1"]);
    assert.equal((await searchWorkspaceHistory(f.db, candidates, { query: "secret" })).hits.length, 0);
    assert.equal((await searchWorkspaceHistory(f.db, candidates, { query: "中" })).hits[0].entryId, "a1");
  } finally { f.close(); }
});

test("搜索来源：待落盘、已登记丢失、损坏分别报告，其他来源继续；旧游标按扫描语义", async () => {
  const f = fixture();
  try {
    const good = f.candidate("good", [record("g1", "needle"), record("g2", "needle")]);
    const corrupt = f.candidate("corrupt", [record("bad", "before")]);
    fs.appendFileSync(corrupt.filePath!, "{broken}\n");
    const missing = f.candidate("missing", [record("m1", "old")]);
    f.index.sync(missing.sessionId, missing.filePath!); fs.unlinkSync(missing.filePath!);
    const result = await searchWorkspaceHistory(f.db, [good, corrupt, missing, { sessionId: "pending", filePath: null, historyExpected: false }, { sessionId: "expected", filePath: null, historyExpected: true }], { query: "needle" });
    assert.equal(result.complete, true);
    assert.deepEqual(result.hits.map(hit => hit.entryId), ["g1", "g2"]);
    assert.deepEqual(result.sourceIssues.map(issue => [issue.sessionId, issue.code]), [["corrupt", "history_corrupt"], ["expected", "history_missing"], ["missing", "history_missing"], ["pending", "history_pending"]]);
    const legacy = await searchWorkspaceHistory(f.db, [good], { query: "needle", cursor: { sessionId: "good", byteOffset: f.index.getEntry("good", "g1")!.byteOffset } });
    assert.deepEqual(legacy.hits.map(hit => hit.entryId), ["g2"]);
  } finally { f.close(); }
});

test("GUI续页：大首条在扫描前有进度，来源替换、截断、条件改变拒绝旧游标", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("large", [record("large1", "x".repeat(2 * 1024 * 1024)), record("large2", "needle")]);
    const first = await searchWorkspaceHistory(f.db, [candidate], { query: "needle" });
    assert.equal(first.complete, false); assert.ok(first.cursor);
    assert.ok(first.progress.indexedBytes > 0); assert.equal(first.scanned, 0);
    assert.ok(first.cursor.readOffset > first.cursor.byteOffset);
    await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "changed", cursor: first.cursor }), error => error instanceof HistoryReadError && error.code === "cursor_invalid");
    fs.truncateSync(candidate.filePath!, 1);
    await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: first.cursor }), error => error instanceof HistoryReadError && error.code === "history_changed");
    fs.unlinkSync(candidate.filePath!);
    await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: first.cursor }), error => error instanceof HistoryReadError && error.code === "history_changed");
  } finally { f.close(); }
});


test("来源问题：部分尾部仍标记待落盘，文件替换使续页失效", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("partial", [record("p1", "needle"), record("p2", "needle")]);
    fs.appendFileSync(candidate.filePath!, '{"partial":');
    const first = await searchWorkspaceHistory(f.db, [candidate], { query: "needle", limit: 1 });
    assert.ok(first.cursor);
    assert.deepEqual(first.unindexedSessionIds, ["partial"]);
    assert.deepEqual(first.sourceIssues, [{ sessionId: "partial", code: "history_pending" }]);
    const replacement = candidate.filePath! + ".new";
    fs.writeFileSync(replacement, fs.readFileSync(candidate.filePath!));
    fs.renameSync(replacement, candidate.filePath!);
    await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: first.cursor }), error => error instanceof HistoryReadError && error.code === "history_changed");
  } finally { f.close(); }
});

test("无命中续页：扫描位置前进并终止，长行和中文保持完整", async () => {
  const f = fixture();
  try {
    const candidates = ["a", "b"].map(id => f.candidate(id, [record(id + "1", "中文".repeat(2000)), record(id + "2", "emoji😀") ]));
    let cursor: WorkspaceHistoryCursor | undefined;
    let scanned = 0;
    for (let page = 0; ; page++) {
      assert.ok(page < 10);
      const result = await searchWorkspaceHistory(f.db, candidates, { query: "未出现", scanLimit: 1, cursor });
      assert.equal(result.hits.length, 0); scanned += result.scanned;
      if (result.complete) break;
      assert.ok(result.cursor); assert.notDeepEqual(result.cursor, cursor); cursor = result.cursor;
    }
    assert.equal(scanned, 4);
  } finally { f.close(); }
});


test("正文与展示一致：损坏任务标记记录来源问题，不返回无法展示的消息", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("bad-marker", [{ type: "custom", id: "start", customType: TASK_START_MARKER, data: { taskId: "first" } },
      { type: "custom", id: "end", customType: TASK_END_MARKER, data: { taskId: "other" } }, record("hidden", "needle")]);
    const result = await searchWorkspaceHistory(f.db, [candidate], { query: "needle" });
    assert.equal(result.hits.length, 0);
    assert.deepEqual(result.sourceIssues, [{ sessionId: "bad-marker", code: "history_corrupt" }]);
  } finally { f.close(); }
});


test("来源复核：最终完成前文件替换也拒绝，不能把新文件按旧位置返回", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("changing", [record("before", "needle")]);
    const pending = searchWorkspaceHistory(f.db, [candidate], { query: "needle" });
    const replacement = candidate.filePath! + ".next";
    fs.writeFileSync(replacement, JSON.stringify(record("after", "needle")) + "\n");
    fs.renameSync(replacement, candidate.filePath!);
    await assert.rejects(pending, error => error instanceof HistoryReadError && error.code === "history_changed");
  } finally { f.close(); }
});


test("阶段游标：超出文件、非索引位置、索引阶段跳过完整行明确拒绝，旧偏移语义保留", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("cursor", [record("first", "needle"), record("second", "needle")]);
    const page = await searchWorkspaceHistory(f.db, [candidate], { query: "needle", limit: 1 });
    assert.ok(page.cursor);
    const size = fs.statSync(candidate.filePath!).size;
    for (const altered of [{ ...page.cursor, byteOffset: size + 1 }, { ...page.cursor, byteOffset: 1 }, { ...page.cursor, readOffset: size + 1 }, { ...page.cursor, phase: "index" as const, byteOffset: 0 }]) {
      await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: altered }), error => error instanceof HistoryReadError && error.code === "cursor_invalid");
    }
    const legacy = await searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: { sessionId: candidate.sessionId, byteOffset: size + 1 } });
    assert.equal(legacy.complete, true);
    f.db.prepare("UPDATE history_index_state SET processed_bytes = 0 WHERE session_id = ?").run(candidate.sessionId);
    await assert.rejects(searchWorkspaceHistory(f.db, [candidate], { query: "needle", cursor: { ...page.cursor, phase: "index", byteOffset: -1, readOffset: size } }), error => error instanceof HistoryReadError && error.code === "cursor_invalid");
  } finally { f.close(); }
});

test("同步旧入口保留 stat 失败语义，GUI 分批入口继续报告来源错误", async () => {
  const f = fixture();
  try {
    const candidate = f.candidate("source", [record("entry", "正文")]);
    const invalid = path.join(candidate.filePath!, "child");
    assert.deepEqual(f.index.sync("old", invalid), { sessionId: "old", added: 0, rebuilt: false, hasPartialTail: false, processedBytes: 0 });
    const result = await searchWorkspaceHistory(f.db, [{ sessionId: "gui", filePath: invalid, historyExpected: true }], { query: "正文" });
    assert.deepEqual(result.sourceIssues, [{ sessionId: "gui", code: "history_unreadable" }]);
  } finally { f.close(); }
});
