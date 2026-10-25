# Agent Note: Desktop 正文渲染迁移 Streamdown

Status: implemented

原始 HTML 转义及仅含 sanitize 的管线由[Markdown 渲染 HTML](../simplification/2026-10-25-desktop-markdown-html.md)取代，其余决定继续适用。

## 问题

桌面四处 Markdown 正文（Code 主／子会话、Personal、文件预览、双端技能）用 react-markdown 逐次全量渲染：模型流式输出中的未闭合代码块、表格会先以错误结构闪现，完整后重排；代码块与表格也没有复制等操作。拥有者要求把渲染换成 Streamdown。

## 决定

四处正文统一经 `apps/desktop/src/renderer/markdown.tsx` 的 `MarkdownText` 渲染 Streamdown。聊天正文用默认 streaming 模式（remend 补全未闭合块），文件预览与技能正文传 `mode="static"` 按落盘内容渲染。会话正文的行内代码文件引用链接改挂 `components.inlineCode`，块级代码与表格交 Streamdown 默认渲染器（自带行号、语言标头与复制操作）。`linkSafety` 关闭：外链沿主进程 `setWindowOpenHandler` 打开系统浏览器；下载类 controls 关闭，因为主进程 `will-download` 直接阻止下载；复制类 controls 保留并提供中文文案。

## 安全管线

Streamdown 默认 rehype 管线为 rehype-raw → rehype-sanitize → rehype-harden：rehype-raw 会先把原始 HTML 解析成元素，使 `skipHtml` 失效；其 sanitize schema 把 img src 限在 http/https；harden 会把相对地址改写成根路径。因此 `MarkdownText` 传自定义 `rehypePlugins` 整体替换为仅含 rehype-sanitize 的管线：默认 schema 上扩展 src 协议放行 file、blob、data，`clobberPrefix` 置空与库默认一致。效果与迁移前一致：原始 HTML 仍跳过，非图片 URL 走库默认转换过滤 `javascript:` 等；图片 src 原样直出，承接[图片直显决定](../simplification/2026-10-25-desktop-markdown-images.md)。

## 备选方案

- 保留 react-markdown 只加流式补全：需要自行维护未闭合块的补全与防重排，等于重写 Streamdown 的核心；放弃。
- 使用 Streamdown 默认管线并用 `allowedTags`／`components` 补图片：src 在 sanitize 阶段已被剥掉，组件层拿不到原地址；且 skipHtml 失效改变已定的原始 HTML 行为；放弃。

## 后果

正文视觉由 Streamdown 默认渲染器的 Tailwind 工具类承担：`.markdown` 与 `.file-markdown` 的元素级旧样式删除，只保留容器与链接基线；`style.css` 加 `@source` 扫描 streamdown dist，`@theme` 补 `--color-sidebar` 映射供代码块容器使用。定稿 demo 链同步修订：`approved-demo-v4` 基础片段删除被取代的 `.file-markdown` 元素规则并加入同一行 `@source`（demo 与生产 css 同在仓库根下四层，相对路径一致），polish 片段裁去 `.file-markdown` 的字号选择器，demo 应用换用同一 `markdown.tsx` 并移除图片占位（补齐[图片直显](../simplification/2026-10-25-desktop-markdown-images.md)在 demo 侧的滞后）；定稿链此前只追加，本次属首次修订，旧态由 git 历史保留。收益是流式正文不再闪错结构，代码块／表格获得复制、全屏等操作；代价是 `strong` 渲染为带 `font-semibold` 的 span、标题字号放大等默认形态，且引入 marked／remend 等 Streamdown 传递依赖。

随后启用 `@streamdown/code`／`math`／`mermaid` 插件：代码高亮用 Shiki 纯 JS 正则引擎（无 wasm，CSP 无需放宽），语法与主题资源经 vite 按需分包；数学经 remark-math／rehype-katex，Streamdown 把 KaTeX 的 rehype 追加在 sanitize 之后（KaTeX 输出不再过滤），单美元记法保持关闭以免价格文本误伤，显示数学须用 `$$` 围栏形式，`\(...\)` 沿 Markdown 转义渲染为普通文本（与 react-markdown 时代一致），KaTeX 样式与字体经 `@import` 打包为同源资源、按 `default-src 'self'` 放行；Mermaid 按需懒加载渲染（cytoscape 等入分包），安全级 strict。三个插件的 `@source` 行与 KaTeX `@import` 同步进定稿链与 demo。`@streamdown/cjk` 未装。Electron `file://` 已验证为安全上下文，复制按钮可用。SSR 回归沿用七类图片地址用例，文件预览 markup 断言随渲染器更新，插件行为另见 `test/desktop-streamdown-plugins.test.ts`；Shiki 高亮着色与 Mermaid 实际图形属客户端异步效果，SSR 不覆盖，真实 Electron 另验。
