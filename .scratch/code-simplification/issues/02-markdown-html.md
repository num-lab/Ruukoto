# 允许桌面 Markdown 渲染 HTML

Status: resolved

## 目标与边界

拥有者于 2026-10-25 在了解现行 HTML 转义行为、冗余 skipHtml 参数及 sanitizer 用途后明确要求「取消这个不渲染html的限制」。Code 主／子会话、Personal、文件预览和双端技能正文渲染 sanitizer 允许的 HTML，脚本、事件属性和危险链接仍由现有过滤处理；代码围栏继续展示源码。

## 方案

共享 MarkdownText 复用 Streamdown 导出的 defaultRehypePlugins.raw，在现有 rehype-sanitize 前解析 HTML，删除 skipHtml 和过时注释。保留图片协议、自定义链接、代码／数学／图表插件及其顺序，不恢复会改写相对图片地址的 harden，不新增依赖。同步可变 Demo 的同名组件与说明，冻结稿保留历史。

扩展现有各入口 SSR 回归，覆盖实际 details／summary／br 元素、脚本和事件属性过滤、危险 HTML 链接、代码围栏转义及已有七类图片地址；同步插件与技能测试名称。更新桌面模块文档，以新 simplification 笔记记录决定并标注旧 HTML 禁令被取代。

## 进展与交接

接手基点为 `3796fe624341f58686d54766a07b30d32d2e9217`，工作区干净。根代理为唯一写入者，已完成实现与文档同步，定向回归、静态检查和独立方案／实现审查均通过；无待办或阻塞，拥有者已授权提交，未推送。职责取舍见[决策笔记](../../../.agents/notes/implemented/simplification/2026-10-25-desktop-markdown-html.md)。

## 验收与证据

工程验收通过：实际组件 SSR 覆盖所有正文入口的 HTML 渲染与过滤，desktop-markdown-images、desktop-streamdown-plugins、desktop-settings-skills 和 desktop-personal-settings-pages 四份定向文件合计 43 项通过，Demo 的 checkInspector 和 npm run check:static 通过。先证明新 HTML 断言在旧实现失败，再在新实现通过。产品主观验收不适用，复用渲染库现有元素、不新增布局；未跑全量测试、原生外壳／浏览器交互或真实模型，原生桥接与 CSP 未改变。

2026-10-25 独立审查者 markdown_html_purpose 直接核实工单和源码，方案与实现审查均通过、无阻断。实现审查对象为相对上述基点的 14 个已跟踪文件差异、本工单与新决策笔记全文，审查后仅补全本工单结果。审查者亲跑 `npx tsx --test test/desktop-markdown-images.test.ts test/desktop-streamdown-plugins.test.ts`，2/2 通过。作者先运行新增 HTML 断言，旧实现的 Code 主会话输出转义标签，未匹配 details／summary／br，回归如期失败。

作者在 macOS arm64 / Node 24.15.0 运行四个定向文件，HTML 和插件两项通过；两条技能页旧断言依赖 img 属性顺序，已改为在同一 img 元素内核实地址与说明，重跑两份技能页文件 41/41 通过。Demo 使用本目录 Vite 配置建立 middleware server 并调用 checkInspector，通过真实组件 SSR 的 HTML 折叠与过滤断言。首次 Demo 探针省略配置导致别名解析失败，恢复仓库配置后通过；不修改运行配置。check:static 全部通过，图片断言微调后补充两文件 ESLint 与根 tsc 均通过；正式与 Demo MarkdownText 逐字一致，git diff --check 通过。Vite 提示 24678 端口占用，未影响 SSR 断言和退出状态。
