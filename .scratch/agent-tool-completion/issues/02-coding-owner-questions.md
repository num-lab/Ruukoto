# Coding 持久提问与可信回答续接

Status: needs-info

## 目标与边界

交付[共享规格第2节](../spec.md#2-结构化提问)的Coding完整切片，支持TUI和Desktop逐题作答、重连及唯一续接。理由见[持久提问笔记](../../../.agents/notes/proposed/feature/2026-10-21-persistent-owner-questions.md)。不混用操作审批，不接管工作流ask，不做多选或任意表单。

## 方案

1. core新增问题、答案回执及事件，schema从实施时版本递增；记录宿主工具操作、真实输入和版本，支持事务消费、取消/失效与快照重建。
2. agent新增ask_user工具族，接host-tools、tool-availability、Plan和当前轮收窄；工具结果后模型可结束本轮，不能继续依赖未回答内容执行业务工具。SubAgent/定时/内部汇总不装配。
3. Runtime.submit的原事务新增宿主私有回答绑定核实，原键查重在前，问题消费/答案/Task插入/事件同事务；control新增查询、答复、取消和原回执查询，pending-requests保留发送前原键。核对普通新输入、取消与重启路径。
4. view快照/事件投影与TUI/Desktop问题卡片一起交付；复用现有选择/输入部件，展示状态和下一步，不能要求用户手写问题ID。回答后正文可由实际历史和prompt快照重建。
5. 同步agent-tools/runtime/control/view/tui/desktop模块文档和usage；核对新增资料的离线导入策略。版本在实际实施时递增，不从旧任务回填授权。

影响路径：`packages/core/src/{db,types,store}.ts`及拟新增问题模块；`packages/agent/src/{host-tools,tool-availability,driver}.ts`；`packages/runtime/src/runtime.ts`；control的ops/server/protocol/pending-requests、view状态、TUI工作流选择部件及Desktop renderer。不跨包反向调用，界面只经control。

## 进展与交接

- 当前角色：方案者；revision2已通过独立审查，非阻塞续接和原入队事务已核实。
- 下一角色：拥有者审阅后决定是否进入实施；实施时先存储和接纳，再同时接两个客户端。
- 当前内容：基点和实际文件见[源码调查](../evidence/investigation.md)，精确被审内容见[审查记录](../evidence/plan-review.md)。
- 阻塞：无事实缺口；未启动运行代码实施。

## 验收与证据

新增`test/owner-questions.test.ts`（拟新增）覆盖创建去重、第二批拒绝、参数校验、双客户端回答、回答/取消竞争、旧版本、同键异参、事务回滚零续接、应答丢失原键重连、重启一次入队；正常新聊天和存档不能误消费或删除问题。

定向回归`test/66-control-seam.test.ts`、`test/12-reconnect-pending.test.ts`、`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`及实际影响的Desktop stream/composer用例。保留`test/114-workflow-owner-input.test.ts`验证原工作流回答未被替换。新增实际SDK历史/请求快照断言，证明题目和答案进入下一轮且不能批准工具。

实施检查为`npm run check:static`和上述有实际影响的最小测试；UI真实验收键盘/自由文本/取消/重连/双窗口，真实模型另验ask后结束与答后续接，不能用mock代替。

工程验收：待验证。产品验收：待验收；独立方案审查见[审查记录](../evidence/plan-review.md)。

## Comments

2026-10-21：普通文本聊天保留原语义，只有可信问题入口消费答案；本轮仅制定方案。
