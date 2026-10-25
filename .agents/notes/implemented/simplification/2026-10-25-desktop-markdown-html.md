# Agent Note: 桌面 Markdown 渲染 HTML

Status: implemented

## 问题

桌面 Markdown 不解析原始 HTML，正常的 details／summary 等内容被显示成标签文本。拥有者了解现行行为后于 2026-10-25 要求取消此限制。Streamdown 在没有 raw 插件时先将 HTML 转成文本，单删 skipHtml 不改变行为。

## 决定

Code 主／子会话、Personal、文件预览和双端技能共用的 MarkdownText 使用 Streamdown 导出的 raw 插件解析 HTML，再运行已有 rehype-sanitize，删除 skipHtml。sanitizer 允许的标签正常渲染，脚本、事件属性和危险链接继续过滤；代码围栏中的 HTML 仍显示源码。可变 Demo 同步，冻结稿保留历史。

图片协议和相对地址、自定义链接与代码／数学／图表插件保持现有处理，不恢复 harden、不增加依赖或配置项。HTML 支持沿用 sanitizer 的标签和属性规则，不承诺执行任意页面代码。

## 既有决定

按 Markdown、原始 HTML、skipHtml 与 HTML 跳过检索 implemented／proposed，无 rejected 目录。本篇部分取代[Streamdown 渲染](../feature/2026-10-25-desktop-streamdown.md)、[图片直显](2026-10-25-desktop-markdown-images.md)、[Code Skills](../feature/2026-10-21-desktop-code-skills.md)、[Demo 检查器](../feature/2026-10-16-demo-inspector-tools.md)和[桌面提案](../../proposed/architecture/2026-10-15-desktop-client.md)的原始 HTML 禁令，其余决定沿用。present 命中描述独立 HTML 文件的源码预览，与 Markdown 内嵌 HTML 无关。实施与验证见[任务记录](../../../../.scratch/code-simplification/issues/02-markdown-html.md)。

## 备选方案

只删除 skipHtml 的改动最少，但仍将 HTML 当作文本，不能满足要求。恢复完整默认管线可少维护插件配置，但默认 sanitize 会删除 file／blob／data 图片地址，harden 会改写相对地址，违反已确认的图片行为。

## 后果

聊天和文档可展示 HTML 折叠块、换行及其他允许的元素；安全过滤继续由现有依赖负责。各正文入口的 SSR 回归同时核实真实 HTML 元素、危险内容过滤、代码围栏转义与七类图片地址。
