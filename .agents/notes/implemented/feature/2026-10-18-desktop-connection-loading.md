# Agent Note: Desktop 首次连接遮罩

Status: implemented

## 问题

拥有者确认加载页后要求去掉可见的 Ruukoto 标题，将剩余内容居中并同步 Desktop。真实连接可能同步回放旧 online、尚未装入快照，也可能首次失败后无限退避；照搬 Demo 计时器会伪造就绪，等待所有重试完成则可能持续遮住恢复入口。

## 决定

Demo 与 Desktop 使用相同的 ConnectionLoading 展示组合和样式差量，单行旋转环与「正在连接后台…」整体居中，DialogTitle 仅供读屏。pending 由 App 提供，展示组件初次 open=true 后按 pending 退出，关闭自动焦点回调才解除底层 inert 与快捷键隔离。Demo 的2.2秒模拟与重播留在 Demo App；正式端不设展示延时或新的连接期限。

Desktop 只覆盖首次本地 Code 连接：connecting 或 online 尚无实例快照时保持；online 且已装实例、failed、closed 或首次 reconnecting 时退出。真实控制连接先安装快照再 online，但宿主订阅可能先重放旧 online，所以必须同时核实实例。reconnecting 表示首轮已失败，结束遮罩后沿用原错误、重连与 PA 设置；之后普通断线重连和未配置 PA 不再全屏阻挡。退出后聚焦消息输入，没有会话时聚焦侧栏按钮。

全屏覆盖以 transform:none 与 translate:initial 分别重置两种位移。translate 的初始值为 none；直接同时写两个 none 会被生产压缩合并为传统 transform，留下 Dialog 的独立 translate:-50% -50%，使加载层偏到左上角。回归读取真实样式差量并经过 Safari 16 目标压缩，要求保留独立重置；生产 CSS 与原生 WKWebView 的矩形均需覆盖验证，开发服务器截图不能替代此项。

本篇部分取代[Demo 加载页](2026-10-18-demo-connection-loading.md)的可见标题与仅限 Demo 范围；其模态隔离、主题和减少动态效果约定继续成立。[启动环境预热](../bug-fix/2026-10-17-desktop-connection-startup.md)的后台与宿主生命周期不变。

## 备选方案

- 用相同的2.2秒计时器迁移最省代码，但会掩盖真实等待或在未连接时退出；正式端只用已有状态。
- 让遮罩持续覆盖 reconnecting 可一直表示连接中，但控制面持续退避可能无限等待，且遮住已有恢复入口；首次重试即结束遮罩。
- 每次切换目标或重连都显示遮罩能统一反馈，但会阻挡未配置 PA 的设置以及已加载内容；只覆盖首次 Code 建连。

## 后果

正式端和 Demo 的外观可直接对照，真实错误仍由原界面报告。同步终态、online 先于快照、失败／重试与退出隔离须使用实际 App 的隔离 bridge 夹具验证；源文件与证据见[迁移工单](../../../../.scratch/desktop-shadcn/issues/28-startup-loading-migration.md)。未改变后台连接、权限或重试策略。
