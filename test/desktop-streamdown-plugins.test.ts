import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("Desktop 正文插件：KaTeX 数学、Mermaid 图表管线与代码块结构，单美元与原始 HTML 不变", async t => {
  const server = await createServer({ configFile: false, root: "apps/desktop/src/renderer", plugins: [react()], server: { middlewareMode: true, hmr: false }, appType: "custom" });
  t.after(() => server.close());
  const MarkdownText: ComponentType<{ children: string }> = (await server.ssrLoadModule("/markdown.tsx")).MarkdownText;
  const render = (body: string) => renderToStaticMarkup(createElement(MarkdownText, { children: body }));
  const math = render(["$$", "E=mc^2", "$$", "", "价格 $5 与 $10，行内 \\(a+b\\)"].join("\n"));
  assert.match(math, /katex-display/);
  assert.match(math, /annotation encoding="application\/x-tex">E=mc\^2</);
  assert.match(math, /\$5 与 \$10/);
  assert.match(math, /\(a\+b\)/);
  const diagram = render("```mermaid\ngraph TD\nA-->B\n```");
  assert.doesNotMatch(diagram, /data-language="mermaid"/);
  assert.match(diagram, /animate-spin/);
  assert.doesNotMatch(diagram, /graph TD/);
  const code = render("```ts\nconst x: number = 1;\n```");
  assert.match(code, /data-language="ts"/);
  assert.match(code, /counter\(line\)/);
  assert.doesNotMatch(code, /<script/);
});
