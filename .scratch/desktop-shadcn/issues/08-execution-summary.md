# Demo 执行中的 Thinking 与 Working

Status: ready-for-human

## 目标与边界

拥有者要求任务执行时在消息流末尾显示带旋转环的 summary：模型思考时为 Thinking；调用工具时为 Working，下方显示已完成和正在进行的工具 rows。继续仅修改可变 demo，不恢复思维链正文，不修改正式 Desktop、后台或冻结稿；工具详情、分组、Read 路径、审批及输入区沿用当前版本。

## 方案

沿用 ToolActivity 与官方 Trace，为活动增加可选 phase（thinking／working），工具增加显式 running 状态，原有无状态样例仍代表完成。Thinking 仅有状态标题和旋转环；Working 默认展开，复用现有各工具行和详情，已完成显示勾选，正在进行显示旋转环与 Reading／Editing／Writing／Running，错误优先于进行中。正在进行的编辑不借 Session 的旧 diff 声称已完成，只在调用本身已有 diff 时显示；命令可展开完整输入与已有部分输出。

在已有演示状态中保留任务执行中入口用于 Thinking，增加 Working 入口用于工具阶段；以显式样例切换，不增加定时器或真实模型调用。执行预览隐藏同一历史中的 pending 审批卡，避免等待审批与运行状态矛盾，原记录不修改，默认场景恢复。活动只在主消息流最后追加一次，键独立于历史索引和预览工具组；状态按当前会话绑定，切换到其他会话后不把旧任务尾部带过去。切换到正常／停止后不留尾部；Working 同样沿用停止和输入排队规则。子 Agent 使用同一活动组件且能够显示显式 running 行，当前无执行样例的不伪造状态。

新增最窄 SSR 断言覆盖 Thinking／Working、投影末尾位置、完成与运行中行、输入／输出／diff 资格及错误优先；浏览器验证正常状态无尾部、停止／排队实际分支、状态切换、末尾、工具展开与路径、会话隔离、明暗／窄栏、减弱动画与滚动。README 和既有工具决策笔记原地同步，demo check、check:static、diff 空白检查及独立审查无阻断后交拥有者看观感。

## 进展与交接

根代理唯一写入者，独立审查者只读。分支 codex/desktop-demo-ui，HEAD 6afb20a；此前所有 demo 未提交改动保留，原始样例与冻结稿不动。独立方案与实现审查无阻断，审查者亲跑最窄 SSR 通过；消费者 aria-label 和失败数增量复核通过。浏览器 Thinking／Working、调用详情、停止／排队／会话隔离、明暗窄栏、减弱动画与真实 wheel 暂停跟随均通过，最终材料审查核对 38 项哈希与 4 张图一致，无阻断；下一步由拥有者审阅产品观感。

## 验收与证据

工程检查通过：demo check、check:static、diff 空白检查及独立 SSR／实现复核；浏览器实测和限制见[本轮验收](../evidence/2026-10-16/execution-summary/verification.md)，源码以同目录 source-hashes.json 为准。最终材料复核通过，工程验收通过；产品观感待拥有者审阅。所有执行与工具状态均为内存模拟，不将浏览器检查记为真实 Electron、模型或命令执行验收。正式端与冻结稿无 diff，未提交。
