# AI Elements demo 验收

2026-10-16；本轮只改独立 demo，依据[工单](../../../issues/03-ai-elements-demo.md)。[原定稿](../../../approved-demo-manifest.json)、正式 GUI、后台与根依赖未迁入本轮 AI Elements 试验。

## 来源与工程检查

使用官方 `radix-rhea` registry 的 message、bubble、trace、collapsible、item、separator、message-scroller 源码；cn 与组件路径改为既有本地入口，图标占位映射 Lucide。独立审查者亲自对 7 份源码和官方 JSON 规范化后逐字比较，全部一致。官方来源为 [AI Elements](https://ui.shadcn.com/docs/ai-elements)、[Message](https://ui.shadcn.com/docs/ai-elements/radix/message)、[Trace](https://ui.shadcn.com/docs/components/radix/trace) 与 [Message Scroller](https://ui.shadcn.com/docs/components/radix/message-scroller)。新增行为依赖只有独立 demo 内固定的 `@shadcn/react` 0.3.1；没有模型 SDK。

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过：TypeScript、SSR 原约定与新组件接入断言、原稿主题逐字一致、Vite 生产构建。SSR 验证主／子消息流各自是 log，消息、气泡、Trace、审批 Item 实际渲染，无新增滚动按钮；原审批决定后消失、无悬浮说明、活动计数与 Read 附注检查继续通过。独立实现审查亲跑同一 check，无阻断。

正式 Desktop 源码及包配置和冻结副本共 64 个文件，前后哈希一致。根 `npm run check:static` 与 `git diff --check` 通过。最终 demo 源码及依赖哈希见同目录 source-hashes.json。

## 浏览器交互

在原有 `http://127.0.0.1:5173/` 浏览器 demo 验证，所有发送与审批均为本地模拟。

| 场景 | 结果 |
| --- | --- |
| Message／Bubble | 用户气泡右对齐，助手正文与内联代码保持原排版；没有新增反馈、编辑或重试操作 |
| Trace 工具活动 | Edit 2 个文件摘要展开真实 TraceCollapsible，Read 不显示行范围；文件与紧邻增删数保留，点击 Edited 打开右栏 diff |
| 独立 SubAgent | Schema Auditor 独立于工具折叠组，点击打开右栏；子用户／助手消息也使用独立 Message Scroller |
| Item 审批 | 批准与拒绝后卡片均消失；不增加结果行或工作区说明 |
| 核实与发送 | 加载期间 textarea.readOnly 为 true，原文字仍在输入框，发送按钮 aria-busy 为 true；模拟核实后清空并追加消息 |
| 底部跟随 | 发送 35 行样例后，主消息 scrollTop=927、clientHeight=578、scrollHeight=1505，跟随至底部；子消息仍为 0 |
| 上翻阅读 | Home 返回 0；再发消息后主 scrollHeight=1665、scrollTop 仍为 0，没有拉回底部 |
| 会话隔离 | A → Tokyo → A 后主／子 scrollTop 均为 0，只有一份输入框，无 Tokyo 正文残留 |
| 侧栏焦点 | 子消息区 Ctrl+J 收起右栏后，right-sidebar 仍为 inert／aria-hidden，焦点回到展开右栏按钮 |
| 主题与窄窗 | 明暗主题正常；760×500 两侧展开时，审批标题与按钮组换行且完整，命令在内容区横向滚动，输入与提交可见 |

浏览器尺寸覆盖已恢复默认。测试样例通过刷新清理，最终页面保留用于拥有者审阅。截图为同目录 dark.png、light.png 与 narrow.png；暂不声称新 demo 已获产品定稿，也没有迁移正式 Electron 或验证真实模型／SSH。
