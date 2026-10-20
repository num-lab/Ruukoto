# Git graph 行窗口化浏览器验收

日期2026-10-18，macOS 27.0.1 arm64、Node v24.15.0、Google Chrome 155.0.8059.84；被测源码与证据指纹见 sha256.json，浏览器输出见 verify.log，静态门禁见 static.log，结构化结果见 result.json。工单见[25](../../issues/25-git-graph-windowing.md)。本轮只读验证正式 renderer 源码与正式 CSS，不连接真实后台，不修改日常应用、后台或 Demo。

## 方法

fixture.mts 用 Vite 临时服务加载正式 GitGraphPanel 与正式 style.css（react 与 tailwind 插件），fixture-app.tsx 使用 405 条受控提交：首条为超长主题与远程分支，末条父提交不在已加载集合；面板固定 320×260，初始两页 200 条，loadMore 受测试开关控制。verify.mjs 启动 headless Chrome 与 DevTools Protocol，页面脚本使用真实滚动、真实 IntersectionObserver 与真实 DOM 测量，结果以 base64 写入页面 `<pre id="result">`，由 verify.mjs 解码并断言。

## 覆盖

| 检查 | 期望 |
| --- | --- |
| initialRowsBounded / rowsBounded* | 窗口行数有界，与已加载 405 条无关 |
| ariaSetsize / ariaPosinset | 行数属性反映已加载总数与行号 |
| horizontalScrollable / scrollLeftAvailable / scrolledRight / sentinelSpansContent | 超长行提供横向滚动，哨兵与内容同宽 |
| horizontalObserverFires | 在底部并横向滚到最右后释放分页，仍能触发下一页（旧哨兵 291px 场景） |
| loadedParentNotMarked / offscreenParentMarked | 窗口外已加载父提交不标「更早提交」，未加载父提交标出 |
| expandHeight / expandPushesRows / detailsVisible / collapseRestores | 展开推送后续行并与总高度一致，折叠恢复 |
| focusPinned / focusRowRendered / focusPinnedInList | 焦点行滚出窗口后 activeElement 仍在旁路行，且 offsetParent 是列表 |
| widthResizeRows / widthResizeScrollStable / widthResizeExpanded | 面板变宽后行仍渲染、滚动位置稳定、展开状态保留 |
| reentryRemeasured / reentryHeightAccounting | 窗口外展开行高度变化后重新进入窗口会重测，总高度与真实行高一致（旧实现缺少窗口依赖时失败） |
| emptyThenFullRows / emptyThenFullScrolls | 空仓库后同一实例收到提交时重新挂接视口测量，窗口能跟到列表末尾 |
| refreshNotEmpty / refreshSetsize / refreshScrollClamped / refreshShowsTail、emptyState | 在底部刷新缩短后不空白、属性更新、滚动位置收在新上限且窗口显示新末页；空仓库显示暂无提交 |

verify.log 记录 34 项通过；需要本机 Chrome，不是 CI 门禁。该证据只代表 Chromium 引擎与受控数据，不代表真实 Git 仓库性能，也不代表 WKWebView／Electron／MyGo 原生窗口的滚动手感、展开动画、输入法与读屏体验；这些保留人工复验。
