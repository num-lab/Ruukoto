# Agent Note: 目标侧离线导入旧实例开发资料

Status: implemented

原编号：ADR 0022

## 问题

产品分离与[旧工作区组织归属](2026-10-03-legacy-workspace-org-attribution.md)落地后，旧开发会话与资料仍在 ruukoto 产品目录混存：普通 dev 会话与 main/coding/chat 角色会话、QQ 群会话、应用数据、调度与 IM 配置共存。旧工作区组织归属只在同一实例内做组织映射，跨实例的导入、备份与切换由本记录负责。预览 → 计划文件 → 应用的流程沿用上述组织映射的模式：拥有者先核对再执行，请求键由计划文件派生，回执先行。

## 决定

实现集中在 `src/runtime/legacy-import.ts` 与 `ruukoto-code legacy-import` CLI；回执和条目账本由 schema v28 引入。

1. **目标侧离线执行。** `ruukoto-code legacy-import preview --from <源数据目录> [--plan 文件]`、`apply --plan 文件`、`revert <导入ID>`、`list` 只在 ruukoto-code 产品下可用，不走控制面；预览与应用都要求目标后台已停止，CLI 持目标实例锁运行。在线导入要处理事件广播与缓存，离线导入后由拥有者启动后台、客户端重连取新快照（补发超限时重取），语义更简单也更可核实。
2. **源全程只读。** 源后台存活（或持锁进程身份无法核实）时拒绝，提示先停止或改用副本。快照 = 把 `ruukoto.db` 及其 WAL 侧车文件逐文件复制到临时目录（0700，命令结束删除），在副本上迁到当前 schema；不用 SQLite 连接直读源目录——读 WAL 库会在源目录生成 `-shm/-wal` 写入侧车。整个流程源目录逐文件 sha256 不变，任何错误路径都不修改源资料。
3. **导入单位是 allow-list 的源项目内普通 dev 会话（含其一层 SubAgent），行 ID 原样保留。** 角色绑定会话、QQ 群会话与 main 资料一律排除。保留 ID 让 JSONL、`result_ref`、记忆 `source_refs` 与产物 ID 都无需重写（[ADR 0018](2026-10-03-legacy-workspace-org-attribution.md) 的同一原则跨实例延伸）。目标已有同 ID 且不属于本源此前导入的行：拒绝，不覆盖未核实的目标数据；同一源续跑时已导入项按账本识别跳过。表级策略（`TABLE_POLICY`）登记每张表导入或排除+理由，未登记的新表使导入拒绝，避免新表被漏判或误复制。
4. **不完整的历史与失效身份如实保留，不伪造。** 会话文件改写为目标 `sessions/` 下同名文件，导入前逐项记录 sha256；源文件缺失或损坏照常导入记录并在报告列出，不生成空历史、不补空文件。项目根四列只在「本机严格核实身份一致（realpath + dev + ino）且目标无同根工作区」时保留，其余清空成为旧来源项目并在回执记录原值与占用方；组织映射按 07 规则保留、改指同根目标工作区或置空待 `project migration-preview` 重新组织。会话 cwd 失效照常导入、标记仅可查阅，继续执行由既有目录身份核查拒绝。
5. **不重放。** queued 任务改 canceled（migration 标注）；running / awaiting_confirmation 改 interrupted（原因 migration），结果未登记且可能已开始执行的工具操作与该任务置 effect_unknown（被未消费审批挡住的操作属「已知未执行」，与运行时恢复的口径一致）；未消费审批（pending 或 approved 未消费）一律 stale；`full_access` 会话默认降为 confirm；导入的 SubAgent 按独立 `closed_at`/`closed_by` 以关闭状态登记，原工作目录不迁移。目标启动后没有可运行的旧任务、没有待消费批准。
6. **跨实例来源与凭据边界 fail-closed。** 项目记忆只在全部版本来源落在导入范围或为 owner_note 时导入；personal 记忆只导入计划中显式选中的条目（拥有者确认的发布）；其余不复制正文，列入待处理（正文留在源实例）。资料授权两端项目都导入时原样导入（含撤销状态）；一端留在源实例时只在回执记录（标注跨实例、不生效），不进 `data_grants`。MCP 与 Jev 配置导入，但目标 `credentials.json` 缺少同名绑定时以停用状态导入并列出，由拥有者重新绑定；agentDir 全部文件（models/auth/default-model/credentials/skills）与 qq/telegram 表一律不复制，预览只列名称与差异，不读取凭据值。
7. **幂等、续跑与恢复路径。** 回执（`instance_imports`）与条目账本（`instance_import_items`，主键 (kind, item_id)）随导入同事务入库（v28）。修订值 = 导入集合（每行整行规范化哈希、文件 sha256）+ 目标冲突状态的规范化哈希：源或目标在预览后变化，应用即报 `revision_conflict`。同请求键同参返回原回执，异参 `request_conflict`。应用先对目标库 `VACUUM INTO` 备份到 `<dataDir>/migration/<导入ID>/target-before.db`（这就是核对备份），再复制文件（临时名 + rename；目标已有同 sha 文件跳过，sha 不同拒绝），最后一个事务插入全部行、账本与回执；中断在事务前用同一计划重跑即可，事务失败整体回滚。回退按账本删除导入的行、事件区间与经 sha256 核对的复制文件，回执保留并标 reverted；导入的会话/项目/记忆在导入后有新的任务、事件、会话、授权、组织引用或新版本时拒绝回退并逐项列出——那是目标侧的事实，不能抹掉。整库恢复保留为手工路径：停止后台后用备份库恢复（见 docs/runtime.md）。
8. **目标写入用单事务逐行 INSERT。** 快照经独立连接读取，目标单事务逐行插入；原子性与逐字节忠实与 ATTACH 方案一致，而转换（收尾、降级、路径改写、停用）在类型化代码中完成，比每表 CASE SQL 更难出错。

## 范围边界

当前范围不包括：在线或控制面导入、TUI/配置中心入口、增量同步（导入后源侧新增只在报告列出，可再次导入）、导入 agentDir 配置与凭据、跨实例授权生效、抽象通用迁移框架。两方向各保留模块并复用既有辅助，个人方向见[个人实例导入](2026-10-05-personal-instance-import.md)。

## 与相关决定的关系

- [ADR 0017](2026-10-02-two-agent-products.md)：开发历史迁入开发产品属于迁移，不是跨端同步，不违反两端独立边界；personal 记忆只导入显式选中的条目，对应「明确选定」的共享范围。[ADR 0017](2026-10-02-two-agent-products.md) 运行位置前提不受影响。
- [ADR 0018](2026-10-03-legacy-workspace-org-attribution.md)：同一原则——保留原 ID 与来源身份，组织归属只作展示——从实例内延伸到跨实例；本记录不绕过产品目录隔离，导入只发生在拥有者显式发起的离线流程。实例内重新组织仍用上述组织映射的工具。
- [ADR 0001](2026-09-19-preserve-session-history.md) 与 [ADR 0016](2026-09-26-lossy-context-compaction.md)（完整历史、有损处理只作用于模型上下文）：导入不改写 JSONL、不重建会话、不改动历史字节；上下文压缩点与选择记录随会话原样迁移。

## 备选方案

在线导入可少一次后台停机并沿用控制面；但需要处理事件广播和运行时缓存的一致性。按[工单 21](../../../../.scratch/agent-direction/issues/21-migrate-coding-instance.md)与原决定，离线持目标实例锁后导入，由拥有者启动后台、客户端重连取新快照，恢复面更易核实。

ATTACH + INSERT…SELECT 可在一条 SQL 路径中跨库复制；但迁移必须收尾任务、降级模式、改写路径与停用缺凭据配置，每张表的 CASE SQL 增加转换出错面。工单 21「实施取舍」确认改用独立快照连接读、目标单事务逐行 INSERT，保留同等原子性和字节忠实。

SQLite 连接直接只读源库可少一次目录快照；但 WAL 库读取可能生成源目录的 -shm/-wal 侧车，违反源全程只读，因此先逐文件复制再在副本读取和升级。

## 后果

旧资料保留原 ID、历史字节与来源身份，可按回执核对和在无目标新活动时回退。代价是源与目标都需停止、先快照后迁移，失效 cwd 只能查阅，跨实例来源和缺凭据配置不能借导入恢复权限。源侧新增只列报告，不做同步；不为个人方向预建通用框架。回退只删账本证明的导入内容，目标新增事实必须保留；产品归属与目标备份不随回退删除。

## 验证

历史实施证据见[工单 21](../../../../.scratch/agent-direction/issues/21-migrate-coding-instance.md)：test/85 7/7、定向回归 123/123、typecheck 通过；全量 npm test 918/919，唯一失败为 test/32 的既有 worktree 目录名环境前提，隔离基线同样失败。smoke-21-migrate-coding-instance.mts 在 macOS 与 ssh tx Linux 各 7/7，真实进程、CLI、SQLite、文件及实例锁，模型模拟。

本机旧实例代表性真实数据完成 preview→apply→目标启动查阅→revert：49 个复制文件与源逐字节一致，备份及回执可核实，源保持只读。真实源没有个人记忆/授权，相关来源规则以逻辑测试覆盖；test/81 曾与另一套件并行时偶发失败，隔离 9/9。运行步骤和手工整库恢复见[运行文档](../../../../docs/runtime.md)「数据布局 / 旧实例开发资料迁入」。
