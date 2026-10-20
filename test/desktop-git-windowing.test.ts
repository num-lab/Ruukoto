import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { GIT_GRAPH_INITIAL_ROWS, GIT_GRAPH_ROW_HEIGHT, gitGraphClampScroll, gitGraphMetrics, gitGraphRange, gitGraphRenderWindow } from "../apps/desktop/src/renderer/git-graph-window.ts";

const expansion = (row: number, extra: number) => ({ row, extra });

test("metrics 按行前缀和计算总高度、偏移并过滤无效展开", () => {
  const base = gitGraphMetrics(100, []);
  assert.equal(base.totalHeight, 100 * GIT_GRAPH_ROW_HEIGHT);
  assert.equal(base.top(0), 0); assert.equal(base.top(50), 50 * GIT_GRAPH_ROW_HEIGHT); assert.equal(base.top(100), base.totalHeight);
  const expanded = gitGraphMetrics(100, [expansion(5, 30), expansion(2, 50), expansion(2, 99), expansion(-1, 40), expansion(100, 40), expansion(3, 0)]);
  assert.equal(expanded.top(2), 2 * GIT_GRAPH_ROW_HEIGHT);
  assert.equal(expanded.top(3), 3 * GIT_GRAPH_ROW_HEIGHT + 50);
  assert.equal(expanded.top(6), 6 * GIT_GRAPH_ROW_HEIGHT + 50 + 30);
  assert.equal(expanded.totalHeight, 100 * GIT_GRAPH_ROW_HEIGHT + 80);
  assert.equal(expanded.top(-5), 0); assert.equal(expanded.top(500), expanded.totalHeight);
});

test("range 覆盖 overscan、零视口、展开行与滚动越界夹紧", () => {
  const metrics = gitGraphMetrics(100, []);
  assert.deepEqual(gitGraphRange(metrics, 0, 0), { first: 0, last: GIT_GRAPH_INITIAL_ROWS });
  const top = gitGraphRange(metrics, 0, 300);
  assert.equal(top.first, 0); assert.ok(top.last >= Math.ceil(300 / GIT_GRAPH_ROW_HEIGHT));
  const middle = gitGraphRange(metrics, 1_400, 300);
  assert.ok(middle.first > 0 && middle.last > middle.first);
  assert.ok(metrics.top(middle.first) <= 1_400 - 6 * GIT_GRAPH_ROW_HEIGHT + GIT_GRAPH_ROW_HEIGHT);
  assert.ok(metrics.top(middle.last) >= 1_400 + 300 + 6 * GIT_GRAPH_ROW_HEIGHT - GIT_GRAPH_ROW_HEIGHT);
  const bottom = gitGraphRange(metrics, 100 * GIT_GRAPH_ROW_HEIGHT, 300);
  assert.equal(bottom.last, 100); assert.ok(bottom.first < 100);
  const expanded = gitGraphMetrics(10, [expansion(0, 500)]);
  assert.equal(expanded.top(1), 528);
  const shifted = gitGraphRange(expanded, 700, 56);
  assert.equal(shifted.first, 1);
  assert.equal(gitGraphClampScroll(5_000, 2_800, 300), 2_500);
  assert.equal(gitGraphClampScroll(-5, 2_800, 300), 0);
  assert.equal(gitGraphClampScroll(100, 200, 300), 0);
});

test("renderWindow 让焦点行在窗口外单独保留，并给出前后位置", () => {
  const metrics = gitGraphMetrics(100, []);
  assert.deepEqual(gitGraphRenderWindow(metrics, 1_400, 300, null).pinned, null);
  const inside = gitGraphRenderWindow(metrics, 1_400, 300, 50);
  assert.equal(inside.pinned, null);
  assert.deepEqual(gitGraphRenderWindow(metrics, 1_400, 300, 2).pinned, { row: 2, before: true });
  const after = gitGraphRenderWindow(metrics, 0, 300, 90);
  assert.equal(after.pinned?.row, 90); assert.equal(after.pinned?.before, false);
  assert.deepEqual(gitGraphRenderWindow(metrics, 0, 300, 999).pinned, null);
});

function linear(count: number) {
  return Array.from({ length: count }, (_value, index) => ({ id: String(index).padStart(40, "0"), parents: index < count - 1 ? [String(index + 1).padStart(40, "0")] : [], subject: `提交 ${index + 1}`, author: "author", date: "2026-10-17", refs: [] }));
}

test("SSR 大量已加载提交只渲染初始窗口，ARIA 与占位高度正确", async () => {
  const server = await createServer({ configFile: false, root: new URL("../apps/desktop/src/renderer", import.meta.url).pathname, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { GitGraphPanel } = await server.ssrLoadModule("/git-graph.tsx");
    const panel = (commits: ReturnType<typeof linear>, head: string | null = commits[0]?.id ?? null) => renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "window", repository: { head, commits, nextCursor: null }, loading: false, onRefresh() {} }));
    const commits = linear(5_000);
    const html = panel(commits);
    const rows = (html.match(/class="git-commit"/g) ?? []).length;
    assert.ok(rows > 0 && rows <= GIT_GRAPH_INITIAL_ROWS, `rows ${rows}`);
    assert.match(html, /aria-setsize="5000"/); assert.match(html, /aria-posinset="1"/);
    assert.match(html, /--git-row-height:28px/); assert.match(html, /cy="14"/);
    for (const tag of html.match(/<svg class="git-graph-lines"[^>]*>/g) ?? []) assert.doesNotMatch(tag, /viewBox/);
    assert.match(html, /height:138880px/);
    assert.match(html, /height:1px/);
    assert.doesNotMatch(html, /position:absolute/);
    const empty = panel([]);
    assert.match(empty, /暂无提交/); assert.doesNotMatch(empty, /class="git-commit"/);
    const short = panel(linear(3));
    assert.equal((short.match(/class="git-commit"/g) ?? []).length, 3);
    assert.match(short, /aria-setsize="3"/); assert.match(short, /aria-posinset="3"/);
    const clipped = renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "window", repository: { head: null, commits: [{ id: "a", parents: ["older"], subject: "a", author: "author", date: "2026-10-17", refs: [] }], nextCursor: null }, loading: false, onRefresh() {} }));
    assert.match(clipped, /（更早提交）/);
    const firstRow = html.slice(html.indexOf('class="git-commit"'), html.indexOf('class="git-commit"', html.indexOf('class="git-commit"') + 1));
    assert.doesNotMatch(firstRow, /（更早提交）/, "已加载但不在窗口内的父提交不应标记为更早");
    assert.match(html, /aria-posinset="2"/);
  } finally { await server.close(); }
});
