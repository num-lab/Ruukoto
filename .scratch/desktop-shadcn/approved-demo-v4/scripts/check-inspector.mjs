import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export async function checkInspector(server) {
  const { browserAddress, isDemoEntry, browserNavigation, navigateBrowser, moveBrowser, workspaceFiles, fileTree, fileTabId } = await server.ssrLoadModule("/src/inspector-data.ts");
  const { BrowserPanel, FilePreview, WorkspaceFiles } = await server.ssrLoadModule("/src/inspector-panels.tsx");
  for (const address of ["", "javascript:alert(1)", "data:text/html,hello", "file:///tmp/example.txt", "blob:https://example.com/id", "mailto:a@example.com", "https://user:pass@example.com", "http://user@example.com", "%"]) {
    assert.equal(browserAddress(address), null, `应拒绝地址 ${address}`);
  }
  assert.equal(browserAddress("example.com"), "https://example.com/");
  assert.equal(browserAddress("localhost:3000/path"), "http://localhost:3000/path");
  assert.equal(browserAddress("127.0.0.1:3000"), "http://127.0.0.1:3000/");
  assert.equal(browserAddress("[::1]:3000/path"), "http://[::1]:3000/path");
  assert.equal(browserAddress(" https://example.com/path?q=1#part "), "https://example.com/path?q=1#part");
  const first = browserNavigation("http://127.0.0.1:5173/browser-preview.html");
  assert.equal(moveBrowser(first, -1), first);
  const second = navigateBrowser(first, "https://example.com/two");
  const third = navigateBrowser(second, "https://example.com/three");
  assert.equal(moveBrowser(third, 1), third);
  const back = moveBrowser(third, -1);
  assert.equal(back.index, 1);
  assert.equal(back.draft, "https://example.com/two");
  assert.equal(moveBrowser(back, 1).draft, "https://example.com/three");
  const branch = navigateBrowser(back, "https://example.com/four");
  assert.deepEqual(branch.history, [first.draft, second.draft, "https://example.com/four"]);
  assert.equal(branch.index, 2);
  const invalid = navigateBrowser(branch, "javascript:alert(1)");
  assert.equal(invalid.error, true);
  assert.equal(invalid.history, branch.history, "无效地址不改变当前页面和历史");
  assert.equal(invalid.revision, branch.revision);
  const repeated = navigateBrowser(invalid, branch.history[branch.index]);
  assert.equal(repeated.history, branch.history);
  assert.equal(repeated.revision, branch.revision + 1, "重复地址应刷新，不重复添加历史");
  assert.equal(repeated.error, false);
  assert.equal(first.index, 0, "其他 tab 的导航数据不应改变");

  const fumo = workspaceFiles("ws-fumo");
  const nexus = workspaceFiles("ws-nexus");
  assert.ok(fumo.some(file => file.path === "src/lib/sync/indexeddb.ts"));
  assert.ok(!nexus.some(file => file.path === "src/lib/sync/indexeddb.ts"));
  assert.deepEqual(workspaceFiles("new-workspace"), []);
  assert.notEqual(fileTabId("ws-fumo", "README.md"), fileTabId("ws-nexus", "README.md"));
  assert.notEqual(fileTabId("ws-fumo", "src/lib/sync/indexeddb.ts"), "src/lib/sync/indexeddb.ts", "预览不能复用 diff 的 id");
  for (const id of ["ws-fumo", "ws-nexus", "ws-eval", "ws-menubar"]) {
    const entries = workspaceFiles(id);
    assert.ok(entries.length > 0);
    assert.equal(new Set(entries.map(file => file.path)).size, entries.length);
  }
  const tree = fileTree(fumo);
  assert.deepEqual(tree.slice(0, 2).map(node => node.kind), ["directory", "directory"]);
  const source = tree.find(node => node.path === "src");
  assert.equal(source.kind, "directory");
  assert.ok(source.children.some(node => node.path === "src/lib"));
  const explorer = renderToStaticMarkup(createElement(WorkspaceFiles, { name: "fumotravel-web", files: fumo, expanded: {}, onExpand() {}, onOpen() {} }));
  assert.ok(explorer.includes('aria-label="预览 src/lib/sync/indexeddb.ts"'));
  assert.ok(explorer.includes('aria-expanded="true"'));
  const collapsed = renderToStaticMarkup(createElement(WorkspaceFiles, { name: "fumotravel-web", files: fumo, expanded: { src: false }, onExpand() {}, onOpen() {} }));
  assert.ok(collapsed.includes('aria-expanded="false"') && !collapsed.includes('aria-label="预览 src/lib/sync/indexeddb.ts"'));
  assert.ok(renderToStaticMarkup(createElement(WorkspaceFiles, { name: "新工作区", files: [], expanded: {}, onExpand() {}, onOpen() {} })).includes("暂无文件"));

  const preview = (file, mode = "preview") => renderToStaticMarkup(createElement(FilePreview, { file, path: file?.path ?? "missing.ts", mode, onMode() {}, onFiles() {}, onUrl() {} }));
  const { highlightSource } = await server.ssrLoadModule("/src/source-highlighting.ts");
  const sourceText = '/* first line\n * second line */\nconst markup = "<script>alert(1)</script> & \"quoted\"";\n\n';
  const highlighted = highlightSource("sample.ts", sourceText);
  assert.ok(highlighted.includes('class="hljs-comment"') && highlighted.includes('class="hljs-keyword"'));
  const withoutTokens = highlighted.replace(/<span class="[^"]+">|<\/span>/g, "");
  assert.equal(`<code>${withoutTokens}</code>`, renderToStaticMarkup(createElement("code", null, sourceText)), "跨行注释、空行、末尾换行与危险文本应逐字保留");
  assert.ok(!highlighted.includes("<script>"), "高亮不得把源码变成实际 HTML");
  assert.equal(highlightSource("unknown.xyz", sourceText), null);
  assert.equal(highlightSource("empty.ts", ""), "");
  for (const id of ["ws-fumo", "ws-nexus", "ws-eval", "ws-menubar"]) {
    for (const file of workspaceFiles(id).filter(file => ["text", "markdown"].includes(file.kind) && file.content)) {
      assert.ok(highlightSource(file.path, file.content)?.includes('class="hljs-'), `样例语言未高亮：${file.path}`);
      assert.ok(preview(file, "source").includes('class="file-source-gutter"'), "高亮与固定行号共享一个滚动容器");
    }
  }
  assert.ok(preview({ path: "plain.txt", kind: "text", content: sourceText }).includes("&lt;script&gt;"), "未知语言由 React 转义为纯文本");
  const escaped = preview({ path: "sample.ts", kind: "text", content: '<script>alert(1)</script>\nsecond line' });
  assert.ok(escaped.includes("&lt;script&gt;") && !escaped.includes("<script>"));
  assert.equal((escaped.match(/class="file-line"/g) ?? []).length, 2);
  const empty = preview({ path: "empty.txt", kind: "text", content: "" });
  assert.ok(empty.includes('aria-label="文件源码"') && !empty.includes('class="file-line"') && !empty.includes("文件不可用"), "空文件保持空源码区");
  const markdownFile = { path: "sample.md", kind: "markdown", content: '# Heading\n\n<script>alert(1)</script>\n\n[web](https://example.com) [credentials](https://user:pass@example.com) [local](./README.md) [fragment](#heading) [mail](mailto:a@example.com) [bad](javascript:alert)\n\n![remote](https://example.com/image.png)' };
  const markdown = preview(markdownFile);
  assert.ok(markdown.includes("<h1>Heading</h1>") && !markdown.includes("<script") && !markdown.includes("<img"));
  assert.equal((markdown.match(/class="file-preview-link"/g) ?? []).length, 1, "只有无凭据 HTTP(S) 链接可打开内置浏览器");
  assert.ok(!markdown.includes("<a "), "Markdown 不得导航父页面");
  assert.ok(preview(markdownFile, "source").includes('aria-label="文件源码"'));
  assert.ok(preview(fumo.find(file => file.kind === "image")).includes('src="/sample-pass.svg"'));
  assert.ok(preview(fumo.find(file => file.kind === "unsupported")).includes("暂不支持预览此文件"));
  assert.ok(preview(undefined).includes("文件不可用"));

  const browser = renderToStaticMarkup(createElement(BrowserPanel, { navigation: first, appOrigin: "http://127.0.0.1:5173", onChange() {} }));
  assert.ok(browser.includes('sandbox="allow-scripts allow-forms"') && !browser.includes("allow-same-origin"));
  assert.ok(browser.includes('referrerPolicy="no-referrer"') || browser.includes('referrerpolicy="no-referrer"'));
  assert.ok(browser.includes('title="网页预览"') && browser.includes("部分网站不允许嵌入"));
  assert.ok(!browser.includes("加载成功"));
  const error = renderToStaticMarkup(createElement(BrowserPanel, { navigation: invalid, appOrigin: "http://127.0.0.1:5173", onChange() {} }));
  assert.ok(error.includes('role="alert"') && error.includes('aria-invalid="true"'));
  for (const address of ["http://127.0.0.1:5173/", "http://127.0.0.1:5173/index.html?view=demo#top"]) {
    assert.equal(isDemoEntry(address, "http://127.0.0.1:5173"), true);
    const ownEntry = renderToStaticMarkup(createElement(BrowserPanel, { navigation: browserNavigation(address), appOrigin: "http://127.0.0.1:5173", onChange() {} }));
    assert.ok(ownEntry.includes("此地址是演示界面本身") && !ownEntry.includes("<iframe"), "父界面应拦住自身入口，避免隔离 iframe 在模块加载前白屏");
  }
  assert.equal(isDemoEntry(first.draft, "http://127.0.0.1:5173"), false);
  assert.equal(isDemoEntry("https://example.com/", "http://127.0.0.1:5173"), false);
  const { workspaceGitRepository, layoutGitGraph } = await server.ssrLoadModule("/src/git-graph-data.ts");
  const { GitGraphPanel, GitCommitDetails } = await server.ssrLoadModule("/src/git-graph.tsx");
  for (const id of [undefined, "personal:main", "ws-eval", "new-workspace", "constructor", "__proto__"]) assert.equal(workspaceGitRepository(id), undefined, "普通目录、PA与未知工作区不提供Git图");
  assert.deepEqual(workspaceGitRepository("ws-menubar"), { head: null, commits: [] }, "空仓库与非仓库不同");
  const commit = (id, parents = []) => ({ id, parents, subject: id, author: "Demo", date: "2026-10-17", refs: [] });
  for (const [commits, expectedLanes] of [
    [[commit("a", ["b"]), commit("b", ["c"]), commit("c")], [0, 0, 0]],
    [[commit("a", ["b", "c"]), commit("b", ["d"]), commit("c", ["d"]), commit("d")], [0, 0, 1, 0]],
    [[commit("a", ["b", "c", "d"]), commit("b", ["e"]), commit("c", ["e"]), commit("d", ["e"]), commit("e")], [0, 0, 1, 2, 0]],
    [[commit("a", ["c"]), commit("b", ["c"]), commit("c")], [0, 1, 0]],
    [[commit("a"), commit("b"), commit("c")], [0, 0, 0]],
  ]) {
    const original = structuredClone(commits);
    const graph = layoutGitGraph(commits);
    assert.deepEqual(graph.rows.map(node => node.lane), expectedLanes, "分叉保留lane，合并复用共享父lane，独立根释放lane");
    assert.equal(graph.edges.length, commits.reduce((count, item) => count + item.parents.length, 0), "每条父关系都有连线");
    for (const [row, item] of commits.entries()) for (const parentId of item.parents) {
      const parent = graph.rows.find(node => node.commit.id === parentId);
      assert.ok(graph.edges.some(edge => edge.from === row && edge.fromLane === graph.rows[row].lane && edge.to === parent.row && edge.toLane === parent.lane && !edge.continuation), "父边连接实际两端节点");
    }
    assert.deepEqual(commits, original, "布局不改写历史");
  }
  const truncated = layoutGitGraph([commit("a", ["b", "missing"]), commit("b")]);
  assert.ok(truncated.edges.some(edge => edge.from === 0 && edge.to === 2 && edge.toLane === 1 && edge.continuation), "窗口外父边延续到底部，不误当根提交");
  for (const id of ["ws-fumo", "ws-nexus", "ws-menubar"]) {
    const repository = workspaceGitRepository(id);
    const positions = new Map(repository.commits.map((item, row) => [item.id, row]));
    for (const [row, item] of repository.commits.entries()) for (const parent of item.parents) assert.ok(positions.has(parent) && positions.get(parent) > row, "样例历史保持新到旧拓扑顺序");
    assert.ok(repository.head === null || positions.has(repository.head));
    const graph = layoutGitGraph(repository.commits);
    const panel = renderToStaticMarkup(createElement(GitGraphPanel, { name: id, repository }));
    assert.ok(panel.includes('aria-label="Git graph"') && panel.includes("只读样例"));
    assert.ok(!/\stitle=/.test(panel), "Git图沿用不添加悬浮说明的约定");
    assert.equal((panel.match(/class="git-commit"/g) ?? []).length, repository.commits.length);
    const graphSvgs = [...panel.matchAll(/<svg\b[^>]*class="git-graph-lines"[^>]*>([\s\S]*?)<\/svg>/g)];
    const graphSvg = graphSvgs.map(match => match[1]).join("");
    assert.equal((graphSvg.match(/<path /g) ?? []).length, graph.edges.length, "每条父边均绘制到SVG");
    assert.equal(graphSvgs.length, repository.commits.length, "每行独立SVG随详情伸展，不用整图固定行高");
    assert.ok(graphSvgs.every(match => !match[0].includes("viewBox=")), "图线用像素定位，详情展开不得缩放摘要节点");
    if (repository.commits.length) {
      assert.ok(panel.includes("HEAD → "));
      assert.ok(panel.includes('aria-label="Git 提交历史"') && !panel.includes("暂无提交"));
      const summaries = [...panel.matchAll(/<button\b[^>]*class="git-commit-summary"[^>]*>([\s\S]*?)<\/button>/g)];
      assert.equal(summaries.length, repository.commits.length);
      assert.ok(summaries.every(match => match[0].includes('aria-expanded="false"') && !match[1].includes("<time") && !match[1].includes("<code")), "每个提交默认折叠，摘要不显示时间或短哈希");
      assert.ok(panel.includes('--git-row-height:28px') && graphSvgs.every(match => /cy="14"/.test(match[1])), "紧凑摘要为28px，节点位于14px中点");
      assert.ok(summaries.every(match => !match[1].includes("lucide-chevron-right")), "提交摘要不显示右侧展开箭头");
      assert.ok(summaries.every(match => !match[0].includes("aria-label=")), "摘要由refs与主题生成读屏名称，不能覆盖分支、tag或HEAD");
      assert.ok(!panel.includes('class="git-commit-detail-body'), "关闭详情不暴露隐藏元数据");
      assert.ok(summaries.every(match => match[1].indexOf('class="git-commit-refs"') < match[1].indexOf('class="git-commit-subject"')), "分支及tag放在主题前");
      assert.ok(summaries.some(match => match[1].includes('data-slot="badge"')), "refs使用现有设计体系Badge");
      if (id === "ws-fumo") {
        const branchColor = [...panel.matchAll(/--git-lane-color:([^";]+)/g)][3]?.[1];
        assert.ok(branchColor && graphSvg.includes(`stroke="${branchColor}"`) && summaries[3][1].includes('class="git-ref-icon"') && summaries[3][1].includes("offline-cache"), "标签图标区与分叉线共用lane语义色");
        assert.ok(summaries[1][1].includes('class="git-ref-remote">origin</em>') && summaries[1][1].includes("远程分支 "), "远程名独立展示且可读屏辨认");
        assert.ok(summaries[4][1].includes("lucide-tag") && summaries[4][1].includes("标签 "), "tag有标签图标与读屏类型");
      }
      assert.ok(panel.includes('<span class="sr-only">根提交</span>'), "读屏应能辨认根提交");
      if (id === "ws-fumo") assert.ok(panel.includes('<span class="sr-only">父提交：7d2c9b4、c24d8e6</span>'), "读屏应能辨认合并的两个父提交");
    } else assert.ok(panel.includes("暂无提交") && !panel.includes("<svg class=\"git-graph-lines\""));
  }
  const graphText = renderToStaticMarkup(createElement(GitGraphPanel, { name: "<img>", repository: { head: "unsafe", commits: [{ ...commit("unsafe"), subject: "<script>alert(1)</script>", author: "<b>", refs: [{ name: "<svg>", type: "branch", remote: "<em>" }] }] } }));
  assert.ok(graphText.includes("&lt;script&gt;") && graphText.includes("&lt;img&gt;") && graphText.includes("&lt;svg&gt;") && graphText.includes("&lt;em&gt;") && !graphText.includes("<script>"), "仓库、提交及ref名称／远程名由React转义");
  const typedRefs = renderToStaticMarkup(createElement(GitGraphPanel, { name: "typed", repository: { head: "a", commits: [{ ...commit("a"), refs: [{ name: "v-next/topic", type: "branch" }, { name: "release", type: "tag" }, { name: "v-next/topic", type: "branch", remote: "upstream" }] }] } }));
  assert.equal((typedRefs.match(/lucide-git-branch/g) ?? []).length, 2, "分支图标不靠v前缀猜类型，本地与远程同名也保留");
  assert.equal((typedRefs.match(/lucide-tag/g) ?? []).length, 1);
  assert.ok(typedRefs.includes('class="git-ref-remote">upstream</em>'));
  const truncatedPanel = renderToStaticMarkup(createElement(GitGraphPanel, { name: "truncated", repository: { head: "a", commits: [commit("a", ["missing"])] } }));
  assert.ok(truncatedPanel.includes('stroke-dasharray="3 3"'), "窗口外父边使用延续样式");
  assert.ok(truncatedPanel.includes('<span class="sr-only">父提交：missing（更早提交）</span>'), "读屏应能辨认窗口外父关系");
  const details = renderToStaticMarkup(createElement(GitCommitDetails, { commit: { ...commit("123456789abcdef", ["abcdef0123", "9876543210"]), subject: "<script>subject</script>", author: "<b>author</b>" } }));
  assert.ok(details.includes('<time dateTime="2026-10-17">2026-10-17</time>') && details.includes("<code>1234567</code>") && details.includes("abcdef0、9876543"), "详情显示日期、短哈希与合并父提交");
  assert.ok(details.includes("&lt;script&gt;subject&lt;/script&gt;") && details.includes("&lt;b&gt;author&lt;/b&gt;") && !details.includes("<script>"), "详情主题与作者仍按纯文本转义");
  assert.ok(renderToStaticMarkup(createElement(GitCommitDetails, { commit: commit("root") })).includes("根提交"));
  process.stdout.write("右栏导航、文件树与预览检查通过\n");
}
