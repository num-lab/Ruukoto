# Demo 右栏扩充验收

2026-10-16，在本机开发页 `http://127.0.0.1:5173/` 验证[工单](../../../issues/04-inspector-tools-demo.md)。仅可变 demo；真实 Desktop、Electron、后台与冻结稿不在本轮实现范围。源码见[哈希](source-hashes.json)，范围保护见[记录](scope-guard.json)。

## 工程检查

- `npm --prefix .scratch/desktop-shadcn/demo run check` 通过：TypeScript、既有首屏／原稿来源回归、新右栏导航／目录／预览检查与生产构建。JS 产物 594.52 kB（gzip 182.14 kB），Vite 提示超过 500 kB；保留提示，没有改阈值。
- `npm run check:static` 通过：lint、全 workspace 类型、笔记树／格式／封印、文档链接／引用／预算／换行。
- `git diff --check` 通过。80 项旧范围快照中 78 项保持原哈希，只有独立 demo package 与 lock 因复用 react-markdown 10.1.0 改变；正式 Desktop、根锁、冻结文件、原始 fixture 和官方原语未改。
- `check-inspector.mjs` 覆盖协议与凭据拒绝、地址规范化、导航边界／分支／同址刷新、工作区文件隔离与目录排序、file／diff 不同 ID、HTML 转义、Markdown 原始 HTML／危险与相对链接／外部图片、空／缺失／图片／不支持文件、iframe sandbox／referrer 与父界面自身入口拦截。

## 浏览器亲验

原生窗口 894×827，右栏 310px；临时 760×827、右栏 260px 后恢复原生尺寸。[测量](layout.json)显示 header 与 aside 横向一致、页面无水平溢出、输入区五个功能键纵坐标相差不超过 1px。标签以最近位置显露，浮点舍入允许 1px 偏差。

| 验收项 | 实际结果 |
| --- | --- |
| 新标签入口 | 加号页打开浏览器或文件树，沿用现有顶部 tab；新工具不增加常驻导航 |
| 目录键盘 | Enter 收起 src、空格展开；切换同工作区另一个会话仍保留展开状态，其他工作区独立 |
| 源码与标签 | 打开 IndexedDB 源码，与同名 diff 分开；重复打开仅一个预览 tab；横向滚动 40px 时首行行号 x=564 保持不变 |
| Markdown | README 排版有标题、列表、代码区；切换源码后离开／返回仍保留该模式，可切回排版 |
| 图片／空／格式 | pass.svg 实际加载完成、naturalWidth=480；notes.txt 源码零行无特殊提示；pass.pdf 显示暂不支持 |
| 浏览器页面 | 默认本地演示页真实显示；页内按钮能切换离线状态，换到文件树再返回仍保留网页状态 |
| 导航与刷新 | 地址栏导航到 view=cache，标题变为本地缓存车票；后退／前进对应页面；刷新重新加载并重置页内状态 |
| 地址错误与自身入口 | javascript 地址显示错误、iframe src 保持原值；同源 index.html 含 query／hash 由父界面提示且无 iframe，后退恢复样例 |
| 会话／工作区隔离 | ft1 的文件预览和地址历史未进入 ft2／nexus；切回 ft1 保留地址历史；新建模拟工作区显示暂无文件 |
| 关闭与收起 | 关闭最后 tab 回到新标签页；关闭／重开浏览器恢复初始历史；地址栏 Ctrl+J 后右栏 hidden／inert、焦点归还展开开关 |
| 调宽与溢出 | 右栏调到 260px 后活动 tab 仍可见；切换或重新展开也显露活动项，不改变网页或焦点 |
| 原视图 | diff 仍展示原增删行，Schema Auditor 仍展示原委派请求与工具摘要 |
| 明暗与窄窗口 | 新面板均可操作，无页面横向溢出；Context、模式、模型与发送保持同排；控制台 error 列表为空 |

[文件树](files-dark.png)、[源码](source-dark.png)、[Markdown](markdown-dark.png)、[浏览器](browser-dark.png)、[窄窗口](browser-narrow.png)、[浅色窄窗口](browser-light-narrow.png)、[浅色 Markdown](markdown-light-narrow.png)保留实际截图。

## 审查与边界

独立方案审查无阻断。实现审查亲跑 demo check 通过；指出自身入口提示依赖被隔离子页模块，实施改为父端判定后，审查者定向 checkInspector 通过并解除阻断。第二审查者独立运行 checkInspector，核对 URL／Markdown／iframe 隔离和状态语义无阻断。新增活动标签显露与 ResizeObserver 也已独立只读复核，浏览器调宽实测通过。最终文档与证据独立复核通过，12 项源码哈希、78 项保护哈希和 21 个本地链接匹配，并核对文件树深色及浏览器浅色窄窗截图；无未解决阻断。

缺失文件和危险 Markdown 使用定向 SSR 构造验证，未通过隐藏状态注入页面。未做真实文件系统、Electron、后台或外站通用兼容验收；远端站点可拒绝嵌入，网页内部跳转不写入地址栏历史。文件全是独立静态样例，不代表真实仓库内容。产品布局和交互由拥有者最终审阅；工程与当前浏览器结果不能替代正式端验收。
