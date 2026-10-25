# Agent Note: Demo 右栏工具预览

Status: implemented

可变 Demo 的原始 HTML 禁令由[Markdown 渲染 HTML](../simplification/2026-10-25-desktop-markdown-html.md)取代，冻结稿保留历史。

## 问题

拥有者需要在可变 demo 内扩充浏览器、文件树和文件预览。[前版定稿](../architecture/2026-10-15-desktop-shadcn-demo.md)只交付 diff 与 SubAgent，正式端禁止直读工作区与加载远程内容；不能把 demo 的新试验自动变成 Electron 或控制面的改动。

## 决定

新增三类右侧 tab，沿用[顶部标签](2026-10-16-demo-header-model-menu.md)与会话隔离，不另设常驻模式栏。文件列表按工作区提供独立静态样例，不由 diff 拼造完整文件，不接本机文件系统；文件预览与 diff 使用不同 ID。源码和文本只读，Markdown 用本仓库已有 react-markdown 的同版本并关闭原始 HTML，图片只使用显式 fixture 资源；空文件保持空源码区，不支持及缺失有明确结果。

浏览器使用受隔离 iframe、地址栏历史与重建刷新；仅接受不含凭据的 http(s)。[MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)说明 load 不能证明成功，站点可拒绝嵌入；[同源策略](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)限制读取跨源内容，因此不伪造标题、最终 URL 或网页内部导航历史。浏览器导航记录按 tab 保留，当前会话切换 tab 保持 frame，切换会话重新装载；不授予 allow-same-origin、顶层导航、弹窗或下载，不添加代理或 Electron webview。默认本地样例可离线核验；父界面在创建 iframe 前识别同源根入口与 /index.html 并显示提示，因为隔离来源会先于 React 入口触发模块 CORS，不能依赖子页脚本防自身嵌套。新开／切换与调宽后显露活动 tab，避免新增工具标签藏在横向溢出区；只滚动标签组，不移动焦点或重建网页。

历史检索中，前版定稿与顶部布局为部分重叠，保留并互链；正式 Desktop 提案继续约束真实端，Agent 自动化浏览器的进程／工具契约与此纯前端 iframe 无关。

## 备选方案

- 直接接 Electron webContents 与真实目录：可以获得完整浏览器历史和工作区，但超出当前 demo，需先设计正式协议及隔离，不能借视觉试验放宽 CSP。
- 用 diff 行推导文件树和完整内容：无需另写 fixture，但变更片段不是完整文件，容易把删除行和缺失行当真实内容。
- 手写 Markdown parser 或直接 innerHTML：依赖最少，但增加格式与脚本处理错误；使用已维护的渲染库并禁原始 HTML。

## 后果

[工单](../../../../.scratch/desktop-shadcn/issues/04-inspector-tools-demo.md)持有导航、隔离、文件各类型、危险地址／文本及窄栏／明暗的验收证据。已有 diff、Agent、审批与单行输入区沿用；工程结果与拥有者最终体验验收分开记录。

iframe 不能替代完整桌面浏览器，外站可拒绝嵌入，网页内部导航不进入地址栏历史；静态文件不代表真实工作区。正式迁移需另行设计读取与浏览器契约，本轮不修改后台。

后续拥有者已明确授权[当前 demo 迁入 Desktop](../architecture/2026-10-16-desktop-current-demo.md)，只读文件和隔离浏览器已按真实端契约接线；本篇静态样例与验收仍保留为 demo 的事实。

正式迁移提交后，拥有者继续在可变 demo 试验[源码高亮与输入交互细化](2026-10-16-demo-input-preview.md)；该轮高亮器只属于可变 demo，未自动迁入正式端或旧冻结稿。

后续[Git graph试验](2026-10-17-demo-git-graph.md)沿用独立标签和会话隔离，仅仓库样例提供只读提交图，不改变本篇的文件树与浏览器契约。

[文件树加载反馈](2026-10-17-desktop-file-tree-loading.md)收窄新标签页展示并取消空目录文案，不改变预览和隔离浏览器的边界。
