# Demo 启动加载页验收

2026-10-18，范围为[工单27](../../issues/27-startup-loading.md)。源文件内容固定在 sources.sha256；工程和交互检查由主代理执行，独立审查者亲自运行 test/43 和 Demo 首屏检查并查看源码、截图。

## 工程检查

Demo 的 npm run check（类型、首屏与工具／右栏检查、Vite 生产构建）、根 npm run check:static 与 test/43 两项均通过；git diff --check 通过。Vite 保留原有大于 500 kB 的 bundle 提醒，本轮未改依赖或代码拆分。

## 浏览器检查

主代理使用真实 IAB 打开 127.0.0.1:5173，首屏为全屏加载页。1280×720 时遮罩矩形与视口精确一致，按 Escape、Cmd+B、Tab 后仍显示加载页，焦点位于 Dialog、底层 inert、左栏保持展开。2.2 秒后进入 closed 淡出，animationName 为 connection-fade-out，底层仍 inert；淡出中 Cmd+B 不改变左栏。Dialog 移除后底层解除 inert，焦点返回输入，主题快捷键恢复。

设置→演示状态→重播连接加载关闭设置并重新显示加载页，按 Tab 焦点仍留在加载页；浅色重播同样就绪恢复。浅色截图时视口宽629px，无水平溢出，遮罩宽度等于视口。浏览器无 error／warn 日志。实际 DOM 断言结果见 browser-metrics.json；明暗截图为 dark.png 与 light.png。

减少动态效果与透明度的回退已核对 CSS，未修改系统偏好实测；本次不接真实后台、不迁移 Desktop。独立审查者的浏览器 inventory 不可用，交互结果沿用主代理证据，不记为双人浏览器复验。

## 查看方式

刷新 Demo 可重新查看首屏；也可通过设置的重播入口重复查看当前主题效果。产品外观等待拥有者体验。
