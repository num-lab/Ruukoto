# 差异栏批注验收

日期：2026-10-16。对象为最新 3 项浏览器批注。[源码记录](gutter-source-hashes.json)覆盖 App、样式和渲染断言。此前行号随代码滚动、Read 行范围与右栏无分隔线的截图保留为历史。

## 工程验收

`npm --prefix .scratch/desktop-shadcn/demo run check`、根 `npm run check:static` 与 `git diff --check` 均通过。

新增展开原活动样例的 SSR 断言，验证 Read 行范围消失、Edit 增删统计与 Agent note 保留。独立源码复核通过，审查者亲自执行 `node scripts/check-render.mjs`，退出码 0。统一宽度内层没有新增滚动容器；行号与标记用 sticky 定位及不透明底色，增删色叠加在底色上。

## 浏览器亲验

独立后台 QA 标签，955×827。Read 详情仅剩动作与文件名，+38、-8 统计保留；右栏头部底边为 1px solid rgba(255,255,255,0.08)，整体高度仍 48px。

在 indexeddb.ts 混合长短行的差异中，用实际横向滚动操作到最右端，scrollLeft 由 0 到 301.5。全部 8 行的行号 x 坐标均固定为 639px，标记均固定为 675px，包含末尾只有右花括号的短行；第一行代码 x 坐标从 689 变为 387.5px。控制台无 error 或 warn，验证结束后关闭 QA 标签并恢复尺寸覆盖，保留原有预览。行号底色没有文字穿透，见[滚到右端的截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Ffixed-gutter-dark.jpg)。

## 范围

仅修改 demo 与相应记录，没有迁移正式 desktop，也没有运行真实 Electron 验收。
