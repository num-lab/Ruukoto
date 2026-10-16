/**
 * 历史读取模块（issue 04 §2）：分页、分段、损坏与部分记录的区分。
 *
 * 纯数据层测试：直接构造 JSONL 文件，不启动后台。
 */

import { startTestRuntime, createProjectSession, routeResponder } from "./helpers/testkit.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TASK_END_MARKER, TASK_START_MARKER } from "@ruukoto/core/types.ts";
import { MAX_FRAME_BYTES } from "@ruukoto/control/protocol.ts";
import {
  HistoryReadError,
  parseSessionFileStrict,
  readHistoryEntryText,
  readHistoryPage,
  readToolResult,
  sliceTextByBytes,
} from "@ruukoto/core/history.ts";

function tmpFile(lines: string[], opts: { trailingNewline?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruukoto-hist-"));
  const file = path.join(dir, "session.jsonl");
  const text = lines.join("\n") + (opts.trailingNewline === false ? "" : "\n");
  fs.writeFileSync(file, text);
  return file;
}

function msgEntry(id: string, role: string, text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-20T00:00:00.000Z",
    message: { role, content: text, timestamp: 1700000000000, ...extra },
  });
}

test("分页和单条读取保留原任务关联；中断缺结束标记后新任务仍可读取，旧无标记消息保留", () => {
  const marker = (id: string, customType: string, taskId: unknown) => JSON.stringify({ type: "custom", id, customType, data: { taskId } });
  const file = tmpFile([msgEntry("legacy", "user", "旧历史"), marker("s1", TASK_START_MARKER, "interrupted"),
    msgEntry("u1", "user", "未结束"), marker("s2", TASK_START_MARKER, "report"), msgEntry("u2", "user", "内部原文"),
    msgEntry("a2", "assistant", "最终总结"), marker("e2", TASK_END_MARKER, "report"), msgEntry("after", "user", "标记外")]);
  try {
    const newest = readHistoryPage(file, { limit: 2 });
    assert.deepEqual(newest.entries.map(entry => [entry.entryId, entry.taskId]), [["a2", "report"], ["after", null]]);
    const older = readHistoryPage(file, { before: newest.nextBefore!, limit: 3 });
    assert.deepEqual(older.entries.map(entry => [entry.entryId, entry.taskId]), [["legacy", null], ["u1", "interrupted"], ["u2", "report"]]);
    assert.equal(readHistoryEntryText(file, "u2").taskId, "report");
    assert.equal(readHistoryEntryText(file, "u2").text, "内部原文");
    for (const lines of [[marker("bad", TASK_START_MARKER, 1)],
      [marker("s", TASK_START_MARKER, "one"), marker("e", TASK_END_MARKER, "other")]]) {
      fs.writeFileSync(file, [...lines, msgEntry("u", "user", "保留")].join("\n") + "\n");
      for (const read of [() => readHistoryPage(file), () => readHistoryEntryText(file, "u")]) {
        assert.throws(read, (err: unknown) => err instanceof HistoryReadError && err.code === "history_corrupt");
      }
    }
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test("工具结果分页：字段独立、UTF-8 连续偏移、末尾空页与空写入", () => {
  const patch = "a中文🙂\n尾行";
  const file = tmpFile([
    msgEntry("edit-page", "toolResult", "普通结果不是补丁", { toolName: "edit", isError: false, details: { patch } }),
    msgEntry("empty-call", "assistant", "", { content: [{ type: "toolCall", id: "empty", name: "write", arguments: { content: "" } }] }),
    msgEntry("empty-result", "toolResult", "写入成功", { toolName: "write", toolCallId: "empty", isError: false }),
    msgEntry("missing", "toolResult", "看起来像补丁的普通结果", { toolName: "edit", isError: false }),
  ]);
  try {
    let offset = 0;
    let assembled = "";
    const totalBytes = Buffer.byteLength(patch);
    do {
      const result = readToolResult(file, "edit-page", 4, { field: "patch", offset });
      assert.ok(result.content);
      assert.equal(result.content.offset, offset);
      assert.equal(result.content.totalBytes, totalBytes);
      assert.ok(result.content.text.length > 0);
      assert.equal(result.content.text.includes("\uFFFD"), false);
      assembled += result.content.text;
      offset += Buffer.byteLength(result.content.text);
    } while (offset < totalBytes);
    assert.equal(assembled, patch);
    assert.deepEqual(readToolResult(file, "edit-page", 4, { field: "patch", offset: totalBytes }).content, { text: "", offset: totalBytes, totalBytes, truncated: true });
    const empty = readToolResult(file, "empty-result", 4, { field: "writeContent" });
    assert.deepEqual(empty.content, { text: "", offset: 0, totalBytes: 0, truncated: false });
    assert.equal(empty.writeTotalLines, 0);
    assert.equal(readToolResult(file, "missing", 4, { field: "patch" }).content, null);
    assert.equal(readToolResult(file, "edit-page", 4, { field: "writeContent" }).content, null);
    for (const read of [
      () => readToolResult(file, "edit-page", 4, { field: "patch", offset: 2 }),
      () => readToolResult(file, "edit-page", 4, { field: "patch", offset: totalBytes + 1 }),
      () => readToolResult(file, "edit-page", 4, { field: "patch", offset: -1 }),
      () => readToolResult(file, "edit-page", 3, { field: "patch" }),
      () => readToolResult(file, "edit-page", 65_537, { field: "patch" }),
      () => readToolResult(file, "missing", 4, { field: "patch", offset: 1 }),
    ]) assert.throws(read, (error: unknown) => error instanceof HistoryReadError && error.code === "invalid_params");
  } finally { fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test("read_tool_result：真实控制面跨 64KiB 补丁与 Write 分页保持总长及旧预览", async () => {
  const t = await startTestRuntime("tool-result-pages", routeResponder([]));
  const patch = "@@ -1 +1 @@\n-旧中文🙂\n+新中文🙂\n".repeat(4_000);
  const written = "新中文🙂\r\n".repeat(9_000) + "末行";
  const file = tmpFile([
    msgEntry("patch", "toolResult", "普通摘要", { toolName: "edit", isError: false, details: { patch, secret: "不公开" } }),
    msgEntry("write-call", "assistant", "", { content: [{ type: "toolCall", id: "write-call", name: "write", arguments: { content: written } }] }),
    msgEntry("write-result", "toolResult", "写入摘要", { toolName: "write", toolCallId: "write-call", isError: true }),
    msgEntry("empty-call", "assistant", "", { content: [{ type: "toolCall", id: "empty-call", name: "write", arguments: { content: "" } }] }),
    msgEntry("empty-result", "toolResult", "写入摘要", { toolName: "write", toolCallId: "empty-call", isError: false }),
    msgEntry("missing-patch", "toolResult", "@@ 不是结构化补丁", { toolName: "edit" }),
    msgEntry("escaped-patch", "toolResult", "\u0001".repeat(100_000), { toolName: "edit", isError: false, details: { patch: "\u0001".repeat(100_000) } }),
  ]);
  try {
    const { sessionId } = await createProjectSession(t.client, t.work[0]!);
    t.runtime.store.setSessionFile(sessionId, file);
    const read = (entryId: string, extra: Record<string, unknown> = {}) => t.client.request<ReturnType<typeof readToolResult>>("read_tool_result", { session_id: sessionId, entry_id: entryId, ...extra });
    for (const [entryId, field, expected] of [["patch", "patch", patch], ["write-result", "writeContent", written]] as const) {
      const preview = await read(entryId);
      assert.equal("content" in preview, false, "旧调用不增加响应字段");
      let offset = 0;
      let assembled = "";
      const totalBytes = Buffer.byteLength(expected);
      do {
        const result = await read(entryId, { field, offset, length: 65_536 });
        const { content, ...legacy } = result;
        assert.deepEqual(legacy, preview, "分页不改变旧预览或成功判定字段");
        assert.ok(content);
        assert.equal(content.offset, offset);
        assert.equal(content.totalBytes, totalBytes);
        const bytes = Buffer.byteLength(content.text);
        assert.ok(bytes > 0 && bytes <= 65_536);
        assert.equal(content.text.includes("\uFFFD"), false);
        assembled += content.text;
        offset += bytes;
        if (offset < totalBytes) fs.appendFileSync(file, msgEntry(`later-${entryId}-${offset}`, "user", "后续条目不改变原字段总长") + "\n");
      } while (offset < totalBytes);
      assert.equal(assembled, expected);
      const last = await read(entryId, { field, offset });
      assert.equal(last.content?.text, "");
      assert.equal(last.content?.offset, totalBytes);
      assert.equal(last.content?.totalBytes, totalBytes);
    }
    assert.deepEqual((await read("patch", { field: "text", length: 65_536 })).content, { text: "普通摘要", offset: 0, totalBytes: 12, truncated: false });
    assert.deepEqual((await read("empty-result", { field: "writeContent" })).content, { text: "", offset: 0, totalBytes: 0, truncated: false });
    assert.equal((await read("missing-patch", { field: "patch" })).content, null);
    assert.equal((await read("missing-patch", { field: "patch" })).isError, null);
    const escaped = await read("escaped-patch", { field: "patch", length: 65_536 });
    assert.equal(escaped.text.length, 16_384);
    assert.equal(escaped.patch?.length, 16_384);
    assert.equal(escaped.content?.text, "\u0001".repeat(65_536));
    assert.ok(Buffer.byteLength(JSON.stringify(escaped)) < MAX_FRAME_BYTES, "六倍 JSON 转义仍可经真实控制面传回");
    const escapedTail = await read("escaped-patch", { field: "patch", offset: 65_536, length: 65_536 });
    assert.equal(escapedTail.content?.text, "\u0001".repeat(34_464));
    assert.equal(escapedTail.content?.totalBytes, 100_000);
    for (const extra of [{ field: "bad" }, { field: null }, { offset: 0 }, { field: "patch", offset: "0" }, { field: "patch", offset: -1 }, { field: "patch", offset: 0.5 }, { field: "patch", offset: Number.MAX_SAFE_INTEGER + 1 }, { field: "patch", offset: 1_000_000 }, { field: "patch", offset: 14 }, { field: "patch", length: 3 }, { field: "patch", length: 65_537 }]) {
      await assert.rejects(read("patch", extra), { code: "invalid_params" });
    }
  } finally { await t.shutdown(); fs.rmSync(path.dirname(file), { recursive: true, force: true }); }
});

test("最新一页与向前翻页：游标链覆盖全部条目且不重复", () => {
  const ids = Array.from({ length: 12 }, (_, i) => `e${String(i).padStart(2, "0")}`);
  const file = tmpFile(ids.map((id, i) => msgEntry(id, i % 2 === 0 ? "user" : "assistant", `消息 ${i}`)));

  const page1 = readHistoryPage(file, { limit: 5 });
  assert.equal(page1.fileAvailable, true);
  assert.deepEqual(page1.entries.map((e) => e.entryId), ["e07", "e08", "e09", "e10", "e11"]);
  assert.equal(page1.nextBefore, "e07");

  const page2 = readHistoryPage(file, { before: page1.nextBefore!, limit: 5 });
  assert.deepEqual(page2.entries.map((e) => e.entryId), ["e02", "e03", "e04", "e05", "e06"]);
  const page3 = readHistoryPage(file, { before: page2.nextBefore!, limit: 5 });
  assert.deepEqual(page3.entries.map((e) => e.entryId), ["e00", "e01"]);
  assert.equal(page3.nextBefore, null, "到顶后没有更老游标");

  const all = [...page3.entries, ...page2.entries, ...page1.entries].map((e) => e.entryId);
  assert.deepEqual(all, ids, "翻页链完整且不重复");
});

test("before 指向不存在的条目：明确 entry_not_found", () => {
  const file = tmpFile([msgEntry("a", "user", "hi")]);
  assert.throws(() => readHistoryPage(file, { before: "nope" }), (err: any) => err.code === "entry_not_found");
});

test("文件尚未落盘：fileAvailable=false，不是错误", () => {
  const page = readHistoryPage(path.join(os.tmpdir(), "ruukoto-hist-nonexistent.jsonl"));
  assert.equal(page.fileAvailable, false);
  assert.deepEqual(page.entries, []);
  const page2 = readHistoryPage(null);
  assert.equal(page2.fileAvailable, false);
});

test("尾部未换行的行是部分记录，不是损坏", () => {
  const file = tmpFile([msgEntry("a", "user", "完整"), '{"type":"message","id":"b","mess'], { trailingNewline: false });
  const page = readHistoryPage(file);
  assert.equal(page.hasPartialTail, true);
  assert.deepEqual(page.entries.map((e) => e.entryId), ["a"], "部分记录不得伪装成完整消息");
});

test("完整行损坏：history_corrupt，不静默跳过", () => {
  const file = tmpFile([msgEntry("a", "user", "好"), "这不是 JSON", msgEntry("b", "assistant", "坏")]);
  assert.throws(
    () => readHistoryPage(file),
    (err: any) => err instanceof HistoryReadError && err.code === "history_corrupt" && /第 2 行/.test(err.message),
  );
});

test("缺少 type/id 的行同样视为损坏", () => {
  const file = tmpFile([JSON.stringify({ hello: "world" })]);
  assert.throws(() => readHistoryPage(file), (err: any) => err.code === "history_corrupt");
});

test("超大单条消息：页内截断 + 分段读取可完整拼回（中文跨分块）", () => {
  // 构造含大量多字节字符的正文
  const big = "汉".repeat(3000) + "tail-marker";
  const file = tmpFile([msgEntry("big", "assistant", big)]);

  const page = readHistoryPage(file, { entryTextCap: 1024 });
  assert.equal(page.entries.length, 1);
  const entry = page.entries[0]!;
  assert.equal(entry.truncated, true);
  assert.equal(entry.totalBytes, Buffer.byteLength(big, "utf8"));
  assert.ok(entry.text.length < big.length);

  // 分段拼回：offset 前进 = offset + 片段字节数
  let offset = 0;
  let assembled = "";
  for (;;) {
    const slice = readHistoryEntryText(file, "big", offset, 777); // 奇数长度迫使边界对齐
    assembled += slice.text;
    const next = slice.offset + Buffer.byteLength(slice.text, "utf8");
    if (!slice.truncated || next <= offset) break;
    offset = next;
  }
  assert.equal(assembled, big, "分段拼接必须还原原文（UTF-8 边界对齐）");
});

test("sliceTextByBytes：任意偏移不产生乱码", () => {
  const text = "a汉b字🙂c";
  const buf = Buffer.from(text, "utf8");
  for (let off = 0; off <= buf.length; off++) {
    for (let len = 0; len <= buf.length - off + 1; len++) {
      const slice = sliceTextByBytes(text, off, len);
      assert.ok(!slice.text.includes("\uFFFD"), `offset=${off} length=${len} 不得出现替换字符`);
    }
  }
});

test("工具关联：assistant 工具调用与 toolResult 消息", () => {
  const assistant = JSON.stringify({
    type: "message",
    id: "m1",
    parentId: null,
    timestamp: "2026-09-20T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "我来读取文件" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x" } },
      ],
      timestamp: 1700000000000,
    },
  });
  const toolResult = JSON.stringify({
    type: "message",
    id: "m2",
    parentId: null,
    timestamp: "2026-09-20T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "文件内容" }],
      isError: false,
      timestamp: 1700000001000,
    },
  });
  const file = tmpFile([assistant, toolResult]);
  const page = readHistoryPage(file);
  assert.equal(page.entries.length, 2);
  assert.deepEqual(page.entries[0]!.toolCalls, [{ toolCallId: "call_1", toolName: "read" }]);
  assert.equal(page.entries[0]!.hasNonTextContent, true);
  assert.equal(page.entries[1]!.toolCallId, "call_1");
  assert.equal(page.entries[1]!.toolName, "read");
  assert.equal(page.entries[1]!.isError, false);
});

test("整页字节预算：保证至少 1 条，超出预算停止收集", () => {
  const entries = Array.from({ length: 10 }, (_, i) => msgEntry(`e${i}`, "user", "x".repeat(1000)));
  const file = tmpFile(entries);
  const page = readHistoryPage(file, { limit: 50, entryTextCap: 2000, pageTextBudget: 3500 });
  assert.equal(page.entries.length, 3, "3500 字节预算装 3 条 1000 字节消息");
  assert.deepEqual(page.entries.map((e) => e.entryId), ["e7", "e8", "e9"]);
  // 单条超过整页预算也返回 1 条
  const huge = tmpFile([msgEntry("huge", "user", "y".repeat(5000))]);
  const page2 = readHistoryPage(huge, { entryTextCap: 6000, pageTextBudget: 100 });
  assert.equal(page2.entries.length, 1);
});

test("parseSessionFileStrict：空文件与仅空白行", () => {
  assert.deepEqual(parseSessionFileStrict(""), { entries: [], hasPartialTail: false });
  assert.deepEqual(parseSessionFileStrict("\n\n"), { entries: [], hasPartialTail: false });
});


test("read_tool_result：实际控制面只返回白名单字段，UTF-8 截断与归属校验", async () => {
  const t = await startTestRuntime("tool-result-view", routeResponder([]));
  try {
    const a = await createProjectSession(t.client, t.work[0]!);
    const b = await createProjectSession(t.client, t.work[1]!);
    const long = "中文".repeat(20_000);
    const writeLong = "中文\r\n".repeat(20_000) + "尾行";
    const file = tmpFile([
      msgEntry("user", "user", "输入"),
      msgEntry("edit", "toolResult", long, { toolName: "edit", isError: false, details: { patch: long, secret: "不可公开" } }),
      msgEntry("failed", "toolResult", "失败", { toolName: "bash", isError: true, details: { secret: "不可公开" } }),
      msgEntry("write-old", "assistant", "", { content: [{ type: "toolCall", id: "write-id", name: "write", arguments: { content: "旧原文" } }] }),
      msgEntry("write-new", "assistant", "", { content: [{ type: "toolCall", id: "write-id", name: "write", arguments: { content: writeLong } }] }),
      msgEntry("write", "toolResult", "写入", { toolName: "write", toolCallId: "write-id", isError: false }),
      ...["", "第一行\r\n第二行\r\n", "第一行\n第二行\n"].flatMap((content, i) => [
        msgEntry(`write-call-${i}`, "assistant", "", { content: [{ type: "toolCall", id: `write-${i}`, name: "write", arguments: { content } }] }),
        msgEntry(`write-result-${i}`, "toolResult", "写入", { toolName: "write", toolCallId: `write-${i}`, isError: false }),
      ]),
      msgEntry("write-missing", "toolResult", "写入", { toolName: "write", toolCallId: "absent", isError: false }),
    ]);
    t.runtime.store.setSessionFile(a.sessionId, file);
    const read = (entryId: string, extra: Record<string, unknown> = {}) => t.client.request<any>("read_tool_result", {
      session_id: a.sessionId, entry_id: entryId, ...extra,
    });
    const result = await read("edit", { length: 7 });
    assert.deepEqual(result, { text: "中文", patch: "中文", writeContent: null, truncated: true, toolName: "edit", isError: false });
    assert.equal(Buffer.byteLength((await read("edit")).text), 16 * 1024 - 1, "默认 16 KiB 按 UTF-8 边界截断");
    assert.equal(Buffer.byteLength((await read("edit", { length: 1_000_000 })).patch), 64 * 1024 - 1, "最多 64 KiB");
    assert.deepEqual(await read("failed"), { text: "失败", patch: null, writeContent: null, truncated: false, toolName: "bash", isError: true });
    assert.deepEqual(await read("write", { length: 6 }), { text: "写入", patch: null, writeContent: "中文", writeTotalLines: 20_001, truncated: true, toolName: "write", isError: false }, "按最近匹配调用读取并截断 Write 原文");
    for (const [i, count] of [0, 2, 2].entries()) {
      assert.equal((await read(`write-result-${i}`)).writeTotalLines, count, "空文件为 0，末尾 LF 或 CRLF 不多算一行");
    }
    assert.equal((await read("write-missing")).writeContent, null);
    await assert.rejects(read("user"), /工具结果条目不存在/);
    await assert.rejects(read("absent"), /工具结果条目不存在/);
    await assert.rejects(read("edit", { session_id: b.sessionId }), /不可读|不存在/);
    await assert.rejects(read("edit", { length: -1 }), /length/);
    await assert.rejects(read("edit", { length: "7" }), /length/);
    await assert.rejects(read("edit", { session_id: "missing" }), /会话不存在/);
  } finally {
    await t.shutdown();
  }
});
