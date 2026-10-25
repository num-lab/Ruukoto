# Agent Note: Desktop Markdown 直接显示图片

Status: implemented

原始 HTML 跳过规则由[Markdown 渲染 HTML](2026-10-25-desktop-markdown-html.md)取代，图片与链接规则继续适用。

## 问题

Desktop 把 Markdown 图片统一替换成文字，正常回复中的截图与插图无法展示。拥有者明确要求删除这些限制；只删占位仍会被 Markdown URL 转换和 CSP 拦截。

## 决定

Code 主／子会话、Personal 聊天、文件预览及双端技能正文直接输出原生 img。图片 src 原样交给浏览器，其他 URL 继续使用渲染库默认转换（现由 [Streamdown 迁移](../feature/2026-10-25-desktop-streamdown.md)的管线提供）；原始 HTML 仍跳过。开发与生产的 img-src 允许网络、file、data 和 blob 来源，图片按容器宽度缩放。沿用库与浏览器，不新增图片代理、路径映射、授权或开关。

## 既有笔记审计

按 desktop、Markdown、图片、img-src 和 CSP 检索 proposed／implemented／rejected。[桌面客户端提案](../../proposed/architecture/2026-10-15-desktop-client.md)的正文图片占位及图片来源限制、[Code Skills](../feature/2026-10-21-desktop-code-skills.md)的图片占位由本篇取代；两篇其他决定保留。[当前 demo 迁移](../architecture/2026-10-16-desktop-current-demo.md)的文件预览仍通过后台读取，本文只改变其 Markdown 内容中的图片加载。[本地网页预览](../feature/2026-10-17-desktop-local-browser.md)管理独立 iframe 资源服务，与本次正文 img 无关。没有需要整篇吸收或退役的笔记。

## 备选方案

- 保留统一占位：避免正文触发图片加载，但无法显示正常回复，违背拥有者删除限制的要求。
- 复用文件预览接口代理全部图片：可沿现有工作区与产物来源核实，也能处理远端路径；需要新增解析和异步加载，本次选择浏览器原生加载。
- 只删除占位 renderer：代码最少，但 file、data、blob 被默认 URL 转换清空，网络图片仍受 CSP 拦截，不能完成删除限制的目标。

## 后果

Markdown 图片不再因应用占位或图片来源策略被禁用，加载与失败由浏览器处理。本机路径指向桌面所在机器，相对路径按页面地址解析；网络图片会向其服务器发请求。本次允许这些原生行为。HTTP 开发页与 MyGo 的 file 访问仍可能受引擎限制，远端工作区路径不自动映射到本机；需要跨主机显示时再单独处理。

实际组件 SSR 回归覆盖主／子会话、Personal、文件和共用技能正文的七类地址、alt、HTML 跳过与危险链接过滤，旧占位实现会失败；CSP 与双端技能页同步现有回归。工程和原生加载证据见[工单](../../../../.scratch/desktop-markdown-images/issues/01-remove-image-restrictions.md)。
