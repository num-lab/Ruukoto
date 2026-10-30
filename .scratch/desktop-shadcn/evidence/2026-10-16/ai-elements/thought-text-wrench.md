# 思考文本与工具图标批注验收

本轮按三条批注，把思考标题改为 `Thought for [time]s`，展开内容改为连续的模拟思考文本，并在主／子消息流的工具摘要前加入扳手。只改 demo 的 Step 样例、共享渲染与对应检查／说明；正式 GUI、后台、原稿快照、官方源码组件、依赖与 CSS 均未改变。前轮[三条摘要验收](chain-of-thought.md)保留为历史版本，当前思考内容以本记录为准。

标题由 durationSeconds 生成，默认样例为 5 秒；展开区用普通 p 展示 text，保留换行与段落，不再显示勾选清单。独立子 Agent 仍使用 Sparkles，内联 code 仍为 13px。默认收起与既有展开状态、审批、文件跳转、滚动保持当前实现；模拟时长与文本没有调用真实模型。

`npm --prefix .scratch/desktop-shadcn/demo run check` 和根 `npm run check:static` 通过。新增 SSR 检查把时长从 5 改为 12，确认标题随数据变化；默认不挂载文本，展开时出现完整文本且无旧勾选图标；主／子流两个 Read files 触发器内均有前置扳手。独立方案与实现复审无阻断，审查者亲跑 demo check。

浏览器为 837×827：确认初始收起、Enter 展开、Space 收起、鼠标展开与工具组正常展开；思考正文保留两段、14px、pre-wrap，239px 窄栏内无横向溢出。扳手位于工具摘要前并隐藏于辅助技术，不改变按钮名称。六处其他区域尺寸和背景前后一致；80 个正式／冻结／来源／依赖保护文件哈希及本轮 CSS 字节核对通过。证据见[截图](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fthought-text-wrench.png)与[测量数据](thought-text-wrench.json)。本轮未重新跑真实模型或 Electron 验收；产品外观交拥有者审阅。
