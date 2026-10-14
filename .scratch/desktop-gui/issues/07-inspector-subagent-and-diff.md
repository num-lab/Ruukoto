# 右栏：SubAgent 页与 diff 页

Status: plan-review

## 目标与边界

实现[规格 R9 的右栏与 R11](../spec.md)：右栏标签页、SubAgent 页（工作委托与子会话历史）、按单次工具调用展示的 diff 页。不做 Accept／Reject。

## 方案

1. SubAgent 页：工作委托与 SubAgent 来自快照与 `work_list`、`work_get`；子会话历史用 `read_history` 读取，复用 view 的流条目投影与中间对话流的渲染组件。
2. diff 页：对话流中 edit 与 write 工具条目可点击，调用 `read_tool_result` 取 `patch` 或 `writeContent`；自写组件逐行渲染 unified patch 的增、删与上下文行；`truncated` 时标明截断；write 只显示写入后的内容。
3. 放行名单加入本单调用的 op。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对 `read_tool_result` 对历史条目与进行中任务的可用范围。
- 基点：`develop` @ `4611eff`。依赖 04。
- 阻塞：04 未完成。

## 验收与证据

工程待验证。单测：unified patch 解析组件对普通、多 hunk、截断与无换行结尾的 patch 输出正确的行类型。

人工检查（外部验收）：委派一个 SubAgent 后，右栏可看到其历史；编辑、截断编辑、写新文件三种 diff 显示正确。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
