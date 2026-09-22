Status: ready-for-agent
Depends on: 01

# main 应用数据空间

## 目标

让 main agent 按需建立待办、提醒、习惯或其他个人数据结构，同时保护 ruukoto 核心数据库。

## 实现范围

- 独立应用数据数据库或等效 namespace，不开放核心 `ruukoto.db`。
- `define_table`、`migrate`、`query`、`insert`、`update`、`delete` 受控工具。
- 表、字段、索引和 schema 版本由 main 提议并持久化；工具验证名称、类型、大小和关系。
- 非破坏性迁移自动执行；删除表、删除字段和批量重写要求拥有者确认。
- 每次 schema/data 变更保存来源任务、agent、版本、时间和理由。
- 查询限制：最大耗时、返回行数、返回字节数和单次扫描范围。
- main 应用数据与 MemoryStore 分工：偏好、约定、决策、经验仍进入长期记忆。

## 验证

- main 能创建不同结构的表并跨重启读写；
- 迁移版本冲突不会静默覆盖；
- 破坏性操作进入确认；
- 核心任务、审批、事件和凭据表无法被应用数据工具访问；
- coding/chat 默认无法查询 main 数据；
- 大查询、恶意表名、超大字段和超时被拒绝并留下事件。
