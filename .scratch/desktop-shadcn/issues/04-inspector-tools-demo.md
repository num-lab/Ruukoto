# Demo 右栏浏览器、文件树与文件预览

Status: ready-for-human

## 目标与授权

拥有者在当前 demo 上要求扩充右栏，加入内置浏览器、文件树和文件预览。沿用现有顶部右侧 tab、Neutral 明暗配色、关闭／新标签／调宽与收起交互，不增加第二层常驻导航。范围仅可变 demo、独立锁与本轮说明／证据；正式 Desktop、Electron CSP／IPC、后台、冻结稿、原始数据与原语不变。旧规格对正式浏览器／文件读取的推迟继续成立，本轮只授权 demo。

## 方案

新标签页增加「浏览器」「文件树」入口，复用 openRight：browser／files／file 三类 tab，浏览器和文件树每会话各一个，文件预览按工作区与路径去重，与 diff ID 分开。tab 和激活项沿用会话隔离；新开／切换及调宽后活动标签自动进入可见区域；浏览器地址草稿、地址栏导航历史／当前位置与刷新计数、Markdown 视图保存在 tab 中，关闭后删除。文件夹展开按工作区保存；切换普通 tab 时保留当前会话浏览器 iframe，切换会话保留导航数据但重新装载页面。

浏览器有单行前进／后退／刷新与地址栏 Enter；只接受不带账号密码的 http／https，地址错误可见且原页面不变，历史回退后新导航截去前进分支，刷新重建 iframe。默认使用 bundled 本地演示页，外站用 sandbox iframe（allow-scripts／allow-forms，无 allow-same-origin、下载、弹窗或顶层导航），不代理抓取、不读取跨源标题／最终 URL／页面内部历史，不依据 load 宣称加载成功。界面保留一行「部分网站不允许嵌入」帮助识别限制；不会把超时当失败。父界面在创建 iframe 前识别同源 / 与 /index.html 入口（含 query／hash），显示提示，避免自身嵌套及隔离来源下的模块加载白屏。

文件树只读，静态样例独立于 diff，按初始四个工作区装配；新工作区为空。用现有 Collapsible／Button 与嵌套列表，目录可键盘展开，文件按钮具有完整路径名称。预览展示源码／文本（固定行号、内容横滚）、Markdown 排版／源码切换、图片，空文本沿用空源码区，不支持格式及缺失文件有明确结果；不读取本机文件、不编辑、不扫描、不搜索、不下载。Markdown 复用本仓库维护的 react-markdown 10.1.0，独立 demo 声明依赖，关闭原始 HTML，不自动加载 Markdown 外部图片，http(s) 链接在内置浏览器打开；不引入高亮器或 GFM 插件。

## 影响与文档

demo-data 扩展 RightTab；新增 inspector-data 的 fixture／目录构建／导航纯逻辑、inspector-panels 的三类视图与本地预览资源；app 只接入口、图标、tab 状态及活动标签显露，main 不变。局部 CSS、现有 check-render、demo 包／锁、README、本工单和决定／证据同步。旧工单与后台清单标明 demo 例外，正式业务清单不扩权。

## 验收

纯逻辑／SSR 覆盖 URL 协议与凭据、地址历史边界／分支／刷新、目录排序和工作区隔离、相同文件与 diff 共存、文本转义、Markdown 原始 HTML／危险链接、空／图片／不支持／缺失文件、iframe sandbox 与非成功状态。浏览器覆盖新标签入口、文件夹键盘、源码与 Markdown 切换、图片、浏览器真实本地页面／地址导航／前后退／刷新、会话和工作区隔离、关闭／重开、窄栏／明暗、原 diff／Agent 与输入区同排。运行 demo check、check:static，亲验和独立实现审查均无阻断后交拥有者审阅；外站是否允许嵌入不作为任意站点兼容承诺。

## 当前阶段

实施与文档同步完成；仅根代理写入。demo check 与根 check:static 通过，894×827／760×827 浏览器亲验覆盖计划场景，证据见[右栏验收](../evidence/2026-10-16/inspector-tools/verification.md)，决定见[笔记](../../../.agents/notes/implemented/feature/2026-10-16-demo-inspector-tools.md)。Vite 仅保留 500 kB chunk 提示。

独立方案与安全／失败语义审查无阻断。实现审查亲跑 demo check，指出自身 iframe 入口模块 CORS 风险；父界面先拦截入口的修正与回归已独立定向复核通过。浏览器发现活动 tab 藏在横向溢出区，已补显露与 ResizeObserver，并独立只读复核与亲验调宽。最终独立文档／证据复核通过：12 项源码哈希、78 项保护哈希及 21 个本地链接匹配，文件树深色与浏览器浅色窄窗截图符合记录，无未解决阻断。当前交拥有者审阅布局和交互，不自动推进真实迁移。
