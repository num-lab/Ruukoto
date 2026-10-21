# Coding 持久提问与可信回答续接

Status: resolved

## 目标与边界

交付[共享规格第2节](../spec.md#2-结构化提问)的Coding完整切片，支持TUI和Desktop逐题作答、重连及唯一续接；拥有者追加授权 Skip 空答案、选项说明与推荐、多选，以及桌面顶部精简。多选以复选框替代编号，不显示多选标签，单选保留编号。理由见[持久提问笔记](../../../.agents/notes/proposed/feature/2026-10-21-persistent-owner-questions.md)与[题型扩展](../../../.agents/notes/implemented/feature/2026-10-21-owner-question-choice-types.md)。不混用操作审批，不接管工作流ask，不做任意表单。

## 方案

1. core新增问题、答案回执及事件，schema从实施时版本递增；记录宿主工具操作、真实输入和版本，支持事务消费、取消/失效与快照重建。
2. agent新增ask_user工具族，接host-tools、tool-availability、Plan和当前轮收窄；工具结果后模型可结束本轮，不能继续依赖未回答内容执行业务工具。SubAgent/定时/内部汇总不装配。
3. Runtime.submit的原事务新增宿主私有回答绑定核实，原键查重在前，问题消费/答案/Task插入/事件同事务；control新增查询、答复、取消和原回执查询，pending-requests保留发送前原键。核对普通新输入、取消与重启路径。
4. view快照/事件投影与TUI/Desktop问题卡片一起交付；复用现有选择/输入部件，展示状态和下一步，不能要求用户手写问题ID。回答后正文可由实际历史和prompt快照重建。
5. 同步agent-tools/runtime/control/view/tui/desktop模块文档和usage；核对新增资料的离线导入策略。版本在实际实施时递增，不从旧任务回填授权。

影响路径：`packages/core/src/{db,types,store}.ts`及拟新增问题模块；`packages/agent/src/{host-tools,tool-availability,driver}.ts`；`packages/runtime/src/runtime.ts`；control的ops/server/protocol/pending-requests、view状态、TUI工作流选择部件及Desktop renderer。不跨包反向调用，界面只经control。

## 进展与交接

- 当前角色：题型扩展实施与独立验收完成；本轮 Skip、多选、选项元数据和顶部精简见[题型验收](../evidence/owner-question-choice-upgrade.md)，先前证据按原范围保留。
- 下一角色：拥有者接收本地提交；未合并或部署，其他切片沿各自工单。
- 当前内容：schema48/协议35，存储、可信入队、工具收窄、view及TUI/Desktop一起交付；此前要求映射、检查、模型快照和独立审查见[实施验收](../evidence/owner-question-acceptance.md)，不将其外推到本轮新题型。原方案依据见[源码调查](../evidence/investigation.md)与[方案审查](../evidence/plan-review.md)。
- 阻塞：无；保留精确版本拒绝，新档案验证不覆盖旧档案；含问题或回执的离线导入明确拒绝。

## 验收与证据

新增`test/owner-questions.test.ts`、`test/owner-question-tools.test.ts`、`test/owner-question-clients.test.ts`及导入/真实模型用例，覆盖创建去重、第二批拒绝、参数校验、双客户端回答、回答/取消竞争、旧版本、同键异参、事务回滚零续接、应答丢失原键重连、重启一次入队；正常新聊天和存档不能误消费或删除问题。活动原任务的控制面取消使问题失效，长选项在窄TUI完整可读，均有新增最窄回归。

定向回归`test/66-control-seam.test.ts`、`test/12-reconnect-pending.test.ts`、`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`及实际影响的Desktop stream/composer用例。保留`test/114-workflow-owner-input.test.ts`验证原工作流回答未被替换。新增实际SDK历史/请求快照断言，证明题目和答案进入下一轮且不能批准工具。

实施检查为`npm run check:static`和上述有实际影响的最小测试；UI真实验收键盘/自由文本/取消/重连/双窗口，真实模型另验ask后结束与答后续接，不能用mock代替。

工程验收：首版及本轮题型扩展通过，静态门禁、按影响回归、桌面构建/签名及独立实现审查无未解决阻断。产品验收：首版原范围见[实施验收](../evidence/owner-question-acceptance.md)；本轮选项说明、推荐、多选复选框、Skip空答案与精简题头已用真实模型、真实Python PTY和隔离Electron核实，见[题型验收](../evidence/owner-question-choice-upgrade.md)。刷新后需要重新选择会话，恢复单卡及原位置通过；不声称旧档案迁移、前台IME、日常进程或CI全平台通过。

## Comments

2026-10-21：普通文本聊天保留原语义，只有可信问题入口消费答案；本轮仅制定方案。

2026-10-21：拥有者指定接手02工单，授权按已审方案实施Coding持久提问；个人接入和后台进程仍属于其他工单。并行实现使用独立工作副本，根工作区由实施者单写。

2026-10-21：再次接手时发现工单现状落后于工作区，核实既有实现后完成独立审查、长选项补修、取消回归、可复审模型快照及双客户端真实断线实验，按最终证据验收；原授权范围未扩展。

2026-10-21：拥有者要求删去桌面卡片无用说明、选项不用列表。桌面改用已有Radix单选组与Button直接显示可换行选项，删除自由输入说明、重复终态与后续任务术语；逐题核对、自由输入、取消和未决恢复语义不变。本次UI结果与检查另记[界面补修](../evidence/owner-question-ui-simplification.md)，原快照和截图保留为补修前证据。

2026-10-21：拥有者要求已答卡片取代对应用户消息，修复桌面始终在底部重复展示的问题。按真实续接任务在同会话原位替换，保留原历史与资料缺失时的原文；待答、取消和失效卡片保留原入口。定向回归48条、补充边界窄测、静态门禁、Electron构建与MyGo打包签名通过，独立复审无阻断；隔离真实Electron验证追加普通聊天及重载后仍只显示一次且位置不变，模型mock。本次结果与截图追加至[界面补修](../evidence/owner-question-ui-simplification.md)，未重启日常应用、未提交或部署。

2026-10-21：拥有者以新参考图指定卡片布局，选项改为编号纵向整行、选中行浅底描边，自由输入置于选项之后，顶部题号和折叠/取消、底部翻页与下一步。沿用逐题必填、最终核对与已答原位替换。组件及客户端26条、静态门禁、文档/笔记检查、Electron构建和MyGo打包签名通过；独立实现与视觉复审无阻断，真实隐藏Electron（mock模型）完成交互提交和窄视口布局验证，结果与限制见[界面补修](../evidence/owner-question-ui-simplification.md)。未重启日常应用、未提交或部署。

2026-10-21：拥有者追加要求 Skip 空答案、选项可选说明/推荐、多选、缩小图标和删除顶部进度/折叠/关闭；随后明确多选以前置复选框替代编号且不加多选标签。本轮同步工具schema、持久解析、待核实记录、模型输入和两个客户端，schema48/协议35沿精确版本拒绝。定向回归、最终静态门禁、真实模型、真实PTY与隔离Electron提交及重新选择会话恢复通过，独立审查无阻断；结果、截图与限制见[题型验收](../evidence/owner-question-choice-upgrade.md)。MyGo重新打包，未重启日常应用、未迁移旧档案、未提交或部署。
