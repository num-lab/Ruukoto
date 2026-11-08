import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "./helpers/vite.ts";
import react from "@vitejs/plugin-react";
import { reorderTab, tabDragOffset } from "../apps/desktop/src/renderer/tab-order.ts";

test("Tab 移动保持对象身份，避让位移匹配目标槽位且取消恢复", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const next = reorderTab(items, 0, 2);
  assert.deepEqual(next, [items[1], items[2], items[0]]);
  assert.deepEqual(items.map(item => item.id), ["a", "b", "c"]);
  assert.equal(reorderTab(items, -1, 2), items);
  assert.deepEqual(items.map(item => tabDragOffset(["a", "b", "c"], "a", "c", item.id)), [2, -1, -1]);
  assert.equal(tabDragOffset(["a", "b"], "a", "a", "b"), 0);
});

test("正式 Git graph 保留紧凑标签、详情和危险文本转义，不含样例数据", async () => {
  const server = await createServer({ configFile: false, root: new URL("../apps/desktop/src/renderer", import.meta.url).pathname, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
  try {
    const { GitGraphPanel, GitCommitDetails } = await server.ssrLoadModule("/git-graph.tsx");
    const commit = { id: "a".repeat(40), parents: [], subject: "<img onerror=alert(1)>", author: "<script>", date: "2026-10-17", refs: [{ name: "main", type: "branch", remote: "origin" }] };
    const html = renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "actual", repository: { head: commit.id, commits: [commit] }, loading: false, onRefresh() {} }));
    assert.match(html, /git-ref-name">HEAD<\/span>/); assert.doesNotMatch(html, /HEAD →/);
    assert.match(html, /远程分支/); assert.match(html, /origin/); assert.doesNotMatch(html, /只读样例|chevron|2026-10-17|<img/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "actual", repository: { head: commit.id, commits: [commit], nextCursor: "page" }, loading: false, onRefresh() {}, onLoadMore() {} })), /加载更多/);
    const failedPage = renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "actual", repository: { head: commit.id, commits: [commit], nextCursor: "page" }, loading: false, onRefresh() {}, onLoadMore() {}, moreError: "Git 历史已变化，请刷新", loadingMore: true }));
    assert.match(failedPage, /role="alert".*?Git 历史已变化，请刷新/); assert.match(failedPage, /disabled=""[^>]*>重试/); assert.match(failedPage, /aria-busy="true"/); assert.doesNotMatch(failedPage, /正在读取更早提交/); assert.doesNotMatch(failedPage, /只显示最近/);
    const branches = Array.from({ length: 8 }, (_value, index) => String(index));
    const graph = renderToStaticMarkup(createElement(GitGraphPanel, { active: true, name: "lanes", repository: { head: "merge", commits: [{ ...commit, id: "merge", parents: branches }, ...branches.map(id => ({ ...commit, id, parents: ["base"] })), { ...commit, id: "base" }] }, loading: false, onRefresh() {} }));
    for (let lane = 0; lane < 6; lane++) assert.ok(graph.includes(`var(--git-lane-${lane})`));
    assert.doesNotMatch(graph, /var\(--(?:primary|muted-foreground|ring)\)/);
    const details = renderToStaticMarkup(createElement(GitCommitDetails, { commit }));
    assert.match(details, /2026-10-17/); assert.match(details, /aaaaaaa/); assert.match(details, /&lt;script&gt;/);
  } finally { await server.close(); }
});
