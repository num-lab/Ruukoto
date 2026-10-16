# 内联文件路径换行修复

2026-10-16；拥有者指出原生样式调整后，窄栏内 `src/components/PassTimeline.tsx` 的扩展名换行居中。上一轮只核对无溢出，没有检查续行对齐，原样式验收不覆盖此项。

原因是文件路径使用原生 button，形成居中的独立行内盒。仅修改 demo 的 renderProse：可打开差异的路径使用原生行内链接，目标为现有检查器，点击时阻止默认跳转并调用原 openDiff；代码保持既有 shadcn 字号、背景和圆角，并允许长路径换行。非路径代码沿用相同换行规则。其他区域、样例数据、依赖和正式 Desktop 未改。

既有 837×827 窗口、两侧展开、正文宽 238px 下重现：旧按钮 display=inline-block、text-align=center，末行 .tsx 的 x=346.14；修复后链接 display=inline、text-align=start，末行 x=244，为正文左边界，后续正文同一行接续。读取实际文字 Range 片段并断言 display、对齐、跨行片段与无溢出；旧布局无法通过这些断言。Enter 与鼠标点击均打开对应差异，页面地址不变；子 Agent 消息流共用渲染入口。

截图与测量见同目录 inline-path-fixed.png 和 inline-path-layout.json。demo check、根 check:static 与 diff 空白检查通过；未迁移正式 Desktop。
