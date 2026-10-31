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
  process.stdout.write("右栏导航、文件树与预览检查通过\n");
}
