import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import type { Session } from "@ruukoto/core/types.ts";
import { CodeState } from "../apps/desktop/src/renderer/code-state.ts";
import { reorderTab, tabDragOffset } from "../apps/desktop/src/renderer/tab-order.ts";
import { fakeSnapshot } from "./helpers/fake-control.ts";
import { waitFor } from "./helpers/testkit.ts";

const session: Session = { id: "same-id", projectId: "main", kind: "dev", workspaceProjectId: null, name: null, branchSource: null, cwd: "/work", cwdReal: "/work", cwdDev: 1, cwdIno: 1, piSessionId: "pi", sessionFile: null, confirmTools: [], createRequestId: null, modelSelection: null, modelSelectionVersion: 0, defaultAccessMode: "confirm", defaultAccessModeVersion: 0, queueState: "active", queuePauseReason: null, createdAt: "2026-10-17T00:00:00Z" };

test("PA 按快照 main 身份读取历史和正文，跨目标相同 session id 不串线", async () => {
  const requests: { target: string; op: string }[] = [];
  const bridge = { request: async (target: "code" | "personal", op: string) => {
    requests.push({ target, op });
    const value = op === "read_history" ? { fileAvailable: true, hasPartialTail: false, entries: [], nextBefore: null } : op === "list_tasks" ? { tasks: [], hasMore: false } : op === "work_list" ? { works: [] } : op === "list_prompt_requests" ? { records: [], hasMore: false } : op === "read_history_entry" ? { entryId: "answer", role: "assistant", text: target, timestamp: session.createdAt, taskId: null, inputPurpose: "user", parentId: null, offset: 0, totalBytes: target.length, truncated: false, toolCalls: [], toolCallId: null, toolName: null, isError: false, hasNonTextContent: false } : [];
    return { ok: true as const, value };
  } };
  const code = new CodeState(bridge, () => {}), pa = new CodeState(bridge, () => {}, "personal");
  for (const model of [code, pa]) {
    model.update({ type: "snapshot", instanceChanged: false, result: { snapshot: fakeSnapshot({ sessions: [session], mainSessionId: session.id }), seq: 0, replay: [] } });
    model.update({ type: "state", state: "online" }); model.openSession(model.view.mainSessionId!);
    await model.loadHistory(session.id);
    model.writes.edit(session.id, model.target);
  }
  pa.update({ type: "event", kind: "live", event: { seq: 1, sessionId: session.id, taskId: "t", createdAt: session.createdAt, body: { type: "task.output_entry", sessionId: session.id, taskId: "t", entryId: "answer", role: "assistant", messageId: null, sessionFile: "/session.jsonl" } } });
  await waitFor("PA 正文", () => pa.view.openSession(session.id).flow.items.some(item => item.kind === "message" && item.text === "personal"));
  assert.ok(requests.some(request => request.target === "personal" && request.op === "read_history"));
  assert.ok(requests.some(request => request.target === "personal" && request.op === "read_history_entry"));
  assert.ok(!code.view.openSession(session.id).flow.items.some(item => item.kind === "message" && item.text === "personal"));
  assert.equal(code.writes.draft(session.id).text, "code"); assert.equal(pa.writes.draft(session.id).text, "personal");
});

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
    assert.match(html, /--git-row-height:28px/); assert.match(html, /cy="14"/);
    assert.match(html, /git-ref-name">HEAD<\/span>/); assert.doesNotMatch(html, /HEAD →/);
    assert.match(html, /远程分支/); assert.match(html, /origin/); assert.doesNotMatch(html, /只读样例|chevron|2026-10-17|<img/);
    assert.doesNotMatch(html.match(/<svg class="git-graph-lines"[^>]*>/)?.[0] ?? "", /viewBox/);
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
