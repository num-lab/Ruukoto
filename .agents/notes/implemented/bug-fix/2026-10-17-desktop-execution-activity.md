# Agent Note: 执行阶段连续反馈与 reasoning 工具批次

Status: implemented

思考的尾部快照与8KiB限制由[完整分块传输](../feature/2026-10-18-complete-reasoning-and-preview.md)部分取代；本文继续持有阶段来源。

## 问题

Driver在模型开始生成工具参数时结束thinking，完整参数尚未生成所以tool_intent还不存在；工具结果与下次模型请求之间也没有未结束thinking。旧前端仅凭未结束thinking显示Thinking，这两处会出现空窗。拥有者同时要求展示已记录reasoning，历史放在工具组第一行，Thinking时直接显示。

## 决定

执行尾部由在线、running、未取消、队列未暂停且无待审批的任务决定。存在真实running工具时显示Working；其余阶段显示Thinking，只有最新同任务阶段是非空assistant流正文时让正文接替。JSONL恢复前，旧message.streaming可能仍为真，不能用全局some隐藏新阶段。

分组前先排除本来不显示的无文本无附件message，避免JSONL空assistant工具调用正文切断reasoning与工具。thinking开启新批次，同任务后续普通工具并入，新的thinking、消息、任务身份或Agent委派隔开批次。即使thinking为空仍保留边界，但不生成空Thought行。历史和Working组的第一行可展开原始reasoning，无后续工具的非空reasoning仍保留独立行；Thinking下只显示当前尚未归属工具组的内容，轮间不复用上轮。累计thinking事件按现有thinkingId替换，不能拼接累计快照。现有Driver只记录8KiB尾部，此处不生成、不推测也不宣称完整内部推理。

本篇部分取代[Trace迁移](../architecture/2026-10-16-desktop-trace-migration.md)与[Demo工具Trace](../feature/2026-10-16-demo-trace-tools.md)的不显示reasoning及仅未结束thinking显示状态的决定，其余详情、错误、身份与恢复约束继续保留。检索上述笔记、Git自动续页和v4迁移，均为部分重叠，无需归档。

Git历史保留纵向自动续页，正文与refs使用自然宽度并允许横向滚动；续页改用aria-busy，不显示加载文字。末尾观察点放在同宽列表内，避免向右滚过一屏后观察点留在视口左侧而停止纵向续页。新标签页移除SubAgent清单，委派入口与已开子会话标签保留；空会话成功加载后留白，真正加载历史时仍反馈。

## 备选方案

在Driver新增模型阶段事件可以表达更精确的provider阶段，但本次只需要连续执行反馈，已有任务与工具事实足够，不扩协议。继续只判断未结束thinking改动最小，却无法覆盖已复现空窗；将旧正文streaming全局视为正文阶段又会压住新轮次。每个thinking单独显示能保留原文，却不符合拥有者要求的工具批次首行。

## 后果

前端保持连续反馈，原始事件与JSONL不变；Thinking代表尚无可显示正文或运行中工具的任务阶段，工具参数生成也归入此状态，并不声称provider每一瞬间正在内部推理。Demo内容明确为静态演示，不能算真实模型验收。真实Driver重放、前端分组与SSR最窄回归见[工单24](../../../../.scratch/desktop-shadcn/issues/24-browser-activity.md)。

## 展示层级的后续决定

[工具平铺与完成后的执行记录](../feature/2026-10-18-completed-trace.md)取代本篇的工具摘要分组与完成后展示方式；调用详情、错误、来源与恢复约束保留。
