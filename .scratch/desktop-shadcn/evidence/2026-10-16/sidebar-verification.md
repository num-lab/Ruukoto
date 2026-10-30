# 外观与侧栏批注验收

日期：2026-10-16。对象为拥有者最新 3 项浏览器批注及删除悬浮说明、添加侧栏过渡的文字要求。[本轮源码](sidebar-source-hashes.json)覆盖 App、数据、样式和渲染检查；旧证据中审批决定后仍显示状态卡、diff 卡片和悬浮说明的行为被本轮取代。

## 工程验收

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过，覆盖类型、首屏渲染、原稿样式一致性与生产构建。根 `npm run check:static` 与 `git diff --check` 通过。新增 SSR 断言分别把样例审批置为 approved、skipped，验证审批卡消失；首屏不含原生 title 或 Tooltip。独立只读方案核对提出门户菜单不受 aside inert 影响，已补受控关闭和焦点归还；最终源码复核无未解决阻断，审查者亲自执行 `node scripts/check-render.mjs` 通过。

## 浏览器亲验

使用独立后台 QA 标签，在 1003×827 下检查：diff 容器背景透明、阴影 none、圆角和 padding 均为 0；文件与 Agent 标签图标计算颜色均为 rgb(94, 100, 112)。批准和拒绝后 command-card 均为 0，切回会话没有再出现。页面原生 title 与 Tooltip 节点均为 0。[最终截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fflat-diff-dark.jpg)显示无卡片差异、灰色标签图标和决定后的对话。

菜单展开时按 Meta+B：门户菜单关闭，左栏最终宽度 0、aria-hidden 为 true、inert 生效，焦点为「展开侧栏」。重开后左栏宽度与内层宽度均为 200px。右标签内按 Meta+J：焦点为「展开右栏」，过渡中外层宽度 39.16px、内层仍为 310px；重开后均为 310px。左右栏计算过渡均为 width、opacity，时长 0.2s。现有 prefers-reduced-motion 规则禁用过渡。760×500 下页面无横向溢出、发送按钮位于正文范围内；控制台无 error 或 warn。验证结束清除尺寸覆盖并关闭 QA 标签，保留原有两个预览标签。

## 范围

仅 demo 与记录修改，未迁移正式 desktop，未运行真实模型、命令、SSH 或 Electron 验收；动画的主观体验待拥有者审阅。
