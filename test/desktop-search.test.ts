import assert from "node:assert/strict";
import { test } from "node:test";
import type { OpResult } from "@ruukoto/control/ops.ts";
import type { DesktopBridge, DesktopResult } from "../apps/desktop/src/shared/bridge.ts";
import { DesktopSearch, foldSearchText, relativeSearchTime, isSearchShortcut, searchSessions } from "../apps/desktop/src/renderer/search-state.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";

type SearchPage = OpResult<"search_history">;
const hit = (id: string): SearchPage["hits"][number] => ({ sessionId: "session", entryId: id, parentId: null, role: "user", timestamp: "2026-10-21T00:00:00.000Z", snippet: "命中文字", matchCount: 1 });
const page = (overrides: Partial<SearchPage> = {}): SearchPage => ({ hits: [], complete: true, cursor: null, scanned: 0, unindexedSessionIds: [], ...overrides });
const settle = async () => { for (let count = 0; count < 8; count++) await Promise.resolve(); };
function harness() {
  const calls: Array<{ params: Record<string, unknown>; resolve: (value: DesktopResult<unknown>) => void }> = [];
  const summaryCalls: Array<(value: DesktopResult<unknown>) => void> = [];
  const bridge: Pick<DesktopBridge, "request"> = { request: async (target, op, params) => {
    assert.equal(target, "code");
    if (op === "list_session_summaries") { assert.deepEqual(params, { scope: "workspace_chats" }); return new Promise(resolve => summaryCalls.push(resolve)); }
    assert.equal(op, "search_history");
    return new Promise(resolve => calls.push({ params, resolve }));
  } };
  const search = new DesktopSearch(bridge, () => {});
  search.update({ type: "state", state: "online" });
  search.update({ type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot(), seq: 0, replay: [] } });
  search.setOpen(true);
  return { search, calls, summaryCalls };
}

test("Spotlight 名称按完整、前缀、子串与活动顺序排序，保留字面空格且仅折叠ASCII", () => {
  const summary = (sessionId: string, name: string, lastActiveAt = "2026-10-21") => ({ sessionId, name, lastActiveAt });
  const summaries = [summary("sub", "xFOO", "2026-10-23"), summary("prefix", "foobar", "2026-10-22"), summary("exact", "Foo", "2026-10-20"), summary("space", " foo "), summary("unicode", "Ä中")];
  assert.deepEqual(searchSessions(summaries, "foo").map(item => item.sessionId), ["exact", "prefix", "sub", "space"]);
  assert.deepEqual(searchSessions(summaries, " foo ").map(item => item.sessionId), ["space"]);
  assert.deepEqual(searchSessions(summaries, "中").map(item => item.sessionId), ["unicode"]);
  assert.equal(foldSearchText("ÄABC中"), "Äabc中");
  assert.equal(searchSessions(Array.from({ length: 10 }, (_, index) => summary(String(index), "会话", `2026-10-${10 + index}`)), "").length, 8);
});

test("Spotlight 输入法结束才debounce，旧请求只允许最新查询接续且始终一页在途", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { search, calls } = harness();
  search.setComposing(true); search.setQuery("中"); context.mock.timers.tick(500);
  assert.equal(calls.length, 0);
  search.setQuery("中文"); search.setComposing(false); context.mock.timers.tick(179); assert.equal(calls.length, 0);
  context.mock.timers.tick(1); assert.equal(calls.length, 1);
  search.setQuery(" 最新 "); context.mock.timers.tick(180); assert.equal(calls.length, 1);
  calls[0].resolve({ ok: true, value: page({ hits: [hit("stale")], complete: false, cursor: { sessionId: "session", byteOffset: 10 } }) });
  await settle();
  assert.equal(calls.length, 2); assert.equal(search.hits.length, 0); assert.equal(calls[1].params.query, " 最新 ");
  calls[1].resolve({ ok: true, value: page({ hits: [hit("latest")] }) }); await settle();
  assert.deepEqual(search.hits.map(item => item.entryId), ["latest"]);
});

test("Spotlight 空页继续推进索引游标，累计来源问题，20条后按需加载且无累计上限", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { search, calls, summaryCalls } = harness();
  summaryCalls.at(-1)!({ ok: true, value: [] }); await settle();
  search.setQuery("命中"); context.mock.timers.tick(180);
  const cursor = { phase: "index" as const, sessionId: "session", byteOffset: -1, readOffset: 1024, queryKey: "query", source: { fileDev: 1, fileIno: 2, minSize: 4096 } };
  const issue = { sessionId: "missing", code: "history_missing" as const };
  calls[0].resolve({ ok: true, value: page({ complete: false, cursor, sourceIssues: [issue], progress: { indexedBytes: 1024, scannedBytes: 0 } }) }); await settle();
  context.mock.timers.tick(0);
  assert.deepEqual(calls[1].params.cursor, { phase: "index", session_id: "session", byte_offset: -1, read_offset: 1024, query_key: "query", source: { file_dev: 1, file_ino: 2, min_size: 4096 } });
  calls[1].resolve({ ok: true, value: page({ hits: Array.from({ length: 20 }, (_, i) => hit(String(i))), complete: false, cursor: { ...cursor, phase: "scan", byteOffset: 2000 }, sourceIssues: [issue] }) }); await settle(); context.mock.timers.tick(0);
  assert.equal(calls.length, 2); assert.equal(search.hits.length, 20); assert.deepEqual(search.sourceIssues, [issue]); assert.equal(search.uncovered, true);
  assert.equal(search.status, "向下滚动可继续加载搜索结果。");
  search.loadMore(); assert.equal(calls.length, 3);
  calls[2].resolve({ ok: true, value: page({ hits: [hit("21")] }) }); await settle();
  assert.equal(search.hits.length, 21); assert.equal(search.complete, true); assert.equal(search.uncovered, true);
});

test("Spotlight 关闭、离线、同实例快照、换实例均不安装旧搜索与旧候选", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const invalidate of ["close", "offline", "snapshot", "instance"] as const) {
    const { search, calls, summaryCalls } = harness();
    search.setQuery("旧词"); context.mock.timers.tick(180);
    if (invalidate === "close") { search.setOpen(false); search.setOpen(true); }
    else if (invalidate === "offline") search.update({ type: "state", state: "reconnecting" });
    else search.update({ type: "snapshot", instanceChanged: invalidate === "instance", result: { snapshot: fakeSnapshot({ instanceId: invalidate === "instance" ? "other" : "inst-1" }), seq: 1, replay: [] } });
    calls[0].resolve({ ok: true, value: page({ hits: [hit("stale")] }) });
    summaryCalls[0]({ ok: true, value: [{ sessionId: "stale", name: "旧实例", lastActiveAt: "2026-10-21" }] });
    await settle();
    assert.equal(search.hits.length, 0);
    if (invalidate !== "close") assert.equal(search.summaries, null);
    search.setOpen(false);
  }
});

test("Spotlight 不推进游标报可重试错误，来源待落盘与完整零命中有区别", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { search, calls } = harness(); search.setQuery("找不到"); context.mock.timers.tick(180);
  calls[0].resolve({ ok: true, value: page({ sourceIssues: [{ sessionId: "pending", code: "history_pending" }], unindexedSessionIds: ["pending"] }) }); await settle();
  assert.equal(search.complete, true); assert.equal(search.uncovered, true);
  search.retry(); context.mock.timers.tick(180);
  calls[1].resolve({ ok: true, value: page({ complete: false }) }); await settle(); context.mock.timers.tick(0);
  assert.match(search.error!, /未推进/); assert.equal(calls.length, 2);
});

test("Spotlight 快捷键在输入区可用，避开其他模态、IME与终端Ctrl+K", () => {
  const key = { key: "k", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false };
  assert.equal(isSearchShortcut(key, false, false), true);
  assert.equal(isSearchShortcut(key, true, false), false);
  assert.equal(isSearchShortcut({ ...key, isComposing: true }, false, false), false);
  assert.equal(isSearchShortcut({ ...key, metaKey: false, ctrlKey: true }, false, true), false);
  assert.equal(isSearchShortcut({ ...key, metaKey: false, ctrlKey: true }, false, false), true);
  assert.equal(isSearchShortcut(key, false, true), true);
});

test("Spotlight 正文扫描结束仍等候标题候选，候选失败不宣称全范围零命中", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { search, calls, summaryCalls } = harness();
  search.setQuery("没有匹配"); context.mock.timers.tick(180);
  calls[0].resolve({ ok: true, value: page() }); await settle();
  assert.equal(search.complete, true); assert.equal(search.summaries, null);
  assert.equal(search.status, "正在加载会话列表…");
  summaryCalls.at(-1)!({ ok: false, error: { code: "unavailable", outcome: "rejected", message: "候选读取失败" } }); await settle();
  assert.match(search.status, /会话列表读取失败/); assert.doesNotMatch(search.status, /没有找到/);
  const retry = search.loadSummaries();
  summaryCalls.at(-1)!({ ok: true, value: [] }); await retry;
  assert.equal(search.status, "没有找到。");
});


test("Spotlight 摘要刷新失败后重新打开会重读，已有候选不能挡住恢复", async () => {
  const { search, summaryCalls } = harness();
  summaryCalls.at(-1)!({ ok: true, value: [{ sessionId: "old", name: "旧候选", lastActiveAt: "2026-10-21" }] }); await settle();
  const refresh = search.loadSummaries();
  summaryCalls.at(-1)!({ ok: false, error: { code: "unavailable", outcome: "rejected", message: "刷新失败" } }); await refresh;
  assert.equal(search.summaries?.[0].sessionId, "old"); assert.equal(search.summariesError, "刷新失败");
  const count = summaryCalls.length;
  search.setOpen(false); search.setOpen(true);
  assert.equal(summaryCalls.length, count + 1);
  summaryCalls.at(-1)!({ ok: true, value: [{ sessionId: "new", name: "新候选", lastActiveAt: "2026-10-22" }] }); await settle();
  assert.equal(search.summariesError, null); assert.equal(search.sessions[0].sessionId, "new");
});

test("Spotlight 相对时间覆盖刚刚、分钟、小时、日、月、年和未来，无效日期不抛错", () => {
  const now = Date.UTC(2026, 9, 22);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const cases = [[-59_999, 0, "second"], [-60_000, -1, "minute"], [-3_599_999, -59, "minute"], [-3_600_000, -1, "hour"], [-86_400_000, -1, "day"], [-30 * 86_400_000, -1, "month"], [-365 * 86_400_000, -1, "year"], [120_000, 2, "minute"]] as const;
  for (const [elapsed, value, unit] of cases) assert.equal(relativeSearchTime(new Date(now + elapsed).toISOString(), now), format.format(value, unit));
  assert.equal(relativeSearchTime("not-a-date", now), "");
});
