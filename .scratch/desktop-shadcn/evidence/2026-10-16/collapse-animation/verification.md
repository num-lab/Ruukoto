# Demo 工作区与消息折叠动画

拥有者要求在可变 demo 给左侧工作区及消息折叠内容增加过渡。本轮只修改 app 的工作区折叠组合与退出交互保护、局部 CSS、README 和既有 AI Elements 笔记；正式 Desktop、后台、冻结稿和官方原语未改。最终[源码哈希](source-hashes.json)记录本轮内容。

`npm --prefix .scratch/desktop-shadcn/demo run check`、`npm run check:static` 与 `git diff --check` 通过。独立只读方案／实现审查无阻断；审查者另跑 SSR 窄检查，确认工作区 open／closed、aria-expanded、hidden／inert 与内容挂载语义，未用 SSR 代替浏览器动画验收。

独立 Playwright CLI Chromium 在 1280×600、no-preference 条件下，捕获真实 animationstart／animationend 并逐帧采样：工作区高度在 0 与 64px 间变化，思考区 0 与 152px，主消息工具组 0 与 88px，子 Agent 工具组 0 与 60px；八个开合方向均有多个中间高度帧，计算时长为 0.18s。所有收起动画开始时 inert 已生效，不等待退出完成才隔离交互。快速连续开关思考区后最终状态收起、内容隐藏或高度归零，随后可以重新展开。

主流在存在 120px 可滚动距离、scrollTop=0 的自由阅读位置展开思考后，scrollTop 仍为 0。切换至 Tokyo 会话没有思考样例，返回离线同步会话保留展开状态；子 Agent 的折叠组独立开合。通过真实浏览器 emulateMedia 切到 reduced-motion: reduce，展开思考区的 animationName 为 none，切回后动画恢复；未修改操作系统偏好。

另行核对工作区筛选强制展开、筛选期间原状态翻转、Escape 清筛选、Enter 键盘折叠与新建会话自动展开所属工作区，断言通过。最终刷新还原样例并在 1280×827 展开思考保存[截图](expanded.png)；静态图仅证明布局和展开结果，动态过渡以上述逐帧记录为证据。

动画最终观感由拥有者审阅；本轮未提交、推送或同步正式 Desktop。临时 Playwright 夹具在系统临时目录，关闭独立浏览器，保留用户已有 demo 标签。
