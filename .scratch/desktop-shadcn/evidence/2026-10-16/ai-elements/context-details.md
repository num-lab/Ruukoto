# Context 详情布局验收

2026-10-16，仅修改可变 demo 的 Context 详情，按拥有者附件排列百分比／约数总量、三色进度条、三行分类。入口仍只显示灰色进度环；颜色沿用 Neutral 背景，灰／紫／蓝用于分类。

`npm --prefix .scratch/desktop-shadcn/demo run check`、根 `npm run check:static` 与 `git diff --check` 通过。构建仍有 500 kB chunk 提示，未改阈值。独立审查核对当前源码、两处新建初始化、样例、CSS、SSR 与文档无阻断，亲跑 `node scripts/check-render.mjs` 通过。

SSR 单独渲染 Portal 内详情，覆盖 0／16／50／100% 数值和色标、分类名称、0 值无 NaN／Infinity、三类合计 32K，以及 18.7K／1M 的紧凑格式与百分比取整。保留原入口无文字、弧线、原生 Progress aria 值、提交和右栏回归。分类 1.5K system、5.3K tools、25.2K messages 均为模拟；没有接真实统计。

浏览器亲验自然 833×827、临时 760×500 后恢复；[深色](context-details-dark.png)、[浅色](context-details-light.png)、[零用量](context-details-zero.png)、[短窄窗口](context-details-narrow.png)保留实际效果。[测量](context-details.json)记录 320×167.57px 详情、5px 条带、三类颜色与 16% Progress 数值，未出现页面横向溢出。短窄窗口弹层处于视口内，五个输入区按键纵坐标相差不超过 1px。

普通新会话和新增工作区首会话均显示 0%／~0、三类各 ~0、进度 Indicator 完全移出轨道；切回原会话恢复 16% 和原分类。聚焦环形入口打开详情，Escape 关闭；截图后恢复原默认样例与自然视口，无新增验收工作区残留。控制台 error 列表为空。

85 个受保护文件逐字保持一致，包括正式 Desktop、根锁、独立 demo 依赖、冻结稿、原始样例、官方原语及上一轮新增右栏文件。未做 Electron 或真实 provider 验收。当前工程与浏览器检查通过，布局由拥有者审阅。
