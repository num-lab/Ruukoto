# Agent Note: 向全新个人实例导入资料并交接平台与调度归属

Status: implemented

原编号：ADR 0023

## 问题

[目标侧离线导入旧实例开发资料](2026-10-04-legacy-instance-import.md) 交付了旧实例开发资料迁入 Coding Agent（`ruukoto-code legacy-import`）；本记录是它的镜像方向：旧 ruukoto 实例的 main 会话、应用数据、调度、平台绑定与必要凭据迁入全新 ruukoto 实例（Personal Agent），旧 coding/chat 档案与发送事实保留为可核查的只读归档。与开发导入方向相比，本方向存在执行归属的交接维度：平台连接与调度计划是"活"状态，导入即把执行权交给目标。机制骨架（源只读快照、目标离线、回执/账本幂等、修订哈希、目标备份、回退阻挡项）复用开发导入模块的导出，不新建通用框架。

## 决定

实现集中在 `packages/channels/src/personal-import.ts` 与 `ruukoto legacy-import` CLI；两个方向复用 `packages/core/src/import-support.ts`，保留各自 `TABLE_POLICY`。

1. **目标侧离线执行，命令按产品分流。** `ruukoto legacy-import preview --from <源数据目录> [--plan 文件]`、`apply --plan 文件`、`revert <导入ID>`、`list` 在 ruukoto 产品下可用（`ruukoto-code legacy-import` 仍为开发导入方向），不走控制面；预览与应用都要求目标后台已停止，CLI 持目标实例锁运行。源与目标同为 ruukoto 产品（或均未登记）且**不同数据目录**：源或目标后台存活、同路径、同实例 ID（同一实例或其副本）都拒绝。
2. **目标必须是全新实例。** 目标后台一旦启动过就有自有角色行与 main 会话；导入源角色行会与其冲突。预览/应用核对：目标已有非同源导入的角色行时拒绝（提示换新目录或先回退同源此前导入），不覆盖未核实的目标数据。角色会话 cwd、`agent_roles.work_dir` 与角色项目根改写为目标 `<dataDir>/../agent-work/<角色>`（apply 时建目录并取目标 dev/ino/realpath）；编排器 `ensureRoles` 幂等跳过已有角色行，启动不重建。
3. **导入单位是角色会话与 QQ 群会话（含 main 的一层 SubAgent），行 ID 原样保留。** main/coding/chat 角色行及其项目与会话、QQ 群会话与群归档四表全量导入；普通 dev 会话及其 SubAgent 与项目一律排除（经 issue 21 迁入 Coding Agent，预览列出并指向）。保留 ID 让 `app_audit.task_id`、记忆 `source_refs`、发送钉版 `source_key`、长期授权 `approval_id`/`created_by_event_id` 都不需重写。表级策略（方向自有的 `TABLE_POLICY`）登记每张表导入或排除+理由，未登记的新表使导入拒绝。记忆只受来源规则约束：全部版本来源落在导入范围（或 owner_note）才导入；**personal 记忆不再要求计划选中**——同产品延续不是跨产品发布（开发导入计划的 `personal_memories` 字段仅属开发方向）。资料授权两端都导入才入库，否则只记回执（跨实例、不生效）。MCP/Jev 配置导入，缺凭据绑定时以停用导入。应用数据是文件级迁移：`agent-data/main.db`（+WAL）经 sha256 核对复制，绑定 meta `app_data.main_instance_id` 随行，`github_retirement_done` 随迁避免目标重跑退役迁移。模型目录、API key 与 agentDir 其余配置不复制（配置中心负责）。
4. **不重放收尾。** 未终态任务收尾为 canceled / interrupted（migration），结果未登记且可能已开始执行的工具操作与任务置 effect_unknown（口径与运行时恢复一致）；未消费审批 stale；未关闭调度运行置 `closed_at`；发送账本 pending→canceled（已知未发送，不当作新请求重发）、sending→effect_unknown；入站 registered/queued→failed；SubAgent 按关闭状态登记；main 会话访问模式**原样保留**（同产品延续，不做开发导入的降级）。目标启动恢复扫描遇到的都是已定终态，不做任何重派、重发或重跑。
5. **平台连接与调度执行归属显式交接。** 导入 `qq_config`/`telegram_config` 原样（含 `config_version` 与 telegram `last_update_id`）与全量入站去重表：目标以偏移继续消费，不回看旧入站；钉版目标（configVersion）不换代，旧待办与授权不因换实例失效。活动调度原样接管，逾期按运行时恢复语义在目标触发一次（合并进未完成运行；旧 pending 发送已取消，不产生双发）。长期授权原样导入：授权绑定机器、单元、动作、main 会话与入口钉版，同机延续时身份链完整、继续有效；跨机或修订不符在使用侧逐项核实、fail-closed 失效。**必要凭据**——平台配置引用的绑定与 purpose `github_webhook` 的绑定——从源 `credentials.json` 合并进目标（同名同值跳过、异值拒绝不覆盖、目标缺失复制）；报告只记录绑定整行 sha256，不落秘密值。旧实例侧不改一字：交接清单写进预览与回执，运行文档要求拥有者在导入后不得再启动旧实例消费平台或调度。
6. **幂等、续跑与回退（复用开发导入全部机制）。** 请求键由计划文件派生（同键同参返回回执，异参 `request_conflict`）；修订 = 导入集合（每行整行规范化哈希）+ 目标冲突状态哈希，预览后源或目标任何行变化即 `revision_conflict`；目标库 VACUUM INTO 备份到 `<dataDir>/migration/<导入ID>/target-before.db`；文件临时名 + rename；最后一个事务入库。
7. **易变资料按报告 manifest 续跑去重与回退核对（v30 账本扩五类）。** 条目账本新增 `agent_role`/`schedule`/`platform_config`/`standing_permission`/`credential` 类别（`instance_import_items` CHECK 重建迁移）；调度运行、发送账本、入站事件、群归档、GitHub 归档不逐行入账，而以回执 manifest（导入行 id 列表 + 整行 sha256，按其写入目标的**转换后行**计算）管理：续跑时目标行与此前（applied 状态）同源回执 manifest 的 sha 一致即跳过——同源回执是唯一"目标行确为本源导入所写"的证据（收尾转换含时间戳，目标行与源快照行 sha 不再相等）——其余同键报 `id_conflict`；回退时逐行 sha 核对。目标启动后的自有活动是阻挡项并逐项列出：新入站事件、新发送操作、新调度/运行、新长期授权、导入行被运行时改写（已发送、已 advance、已消费偏移、撤回标记）、应用数据文件被写、凭据被轮换——切换期间新增的执行及发送事实不抹掉，回退只在无活动时整体移除。凭据摘除与文件移除同样经 sha 核对。导入写入的产品归属（`product.type`）与目标备份不随回退移除（与开发导入方向一致：回退回到"已登记产品的空实例"）。整库恢复保留为手工路径（见运行文档，恢复后不重演副作用）。

## 范围边界

当前范围不包括：在线或控制面导入；源实例写入（含"停用旧平台"的源侧写入）；增量同步（源侧新增只在报告列出）；为两个导入方向抽象通用框架；MCP/Jev 凭据复制；agent-work 目录内容迁移；webhook URL 等外部平台重配置（拥有者按运行文档在目标启动参数重新给出）。

## 与相关决定的关系

- [两个产品](2026-10-02-two-agent-products.md)：个人资料随产品继续归属 ruukoto，本次是一次性迁移而非跨端同步；符合"共享信息不可用时只影响新鲜度"的边界（共享记忆机制另行确定，本记录不实现）。
- [目标侧离线导入旧实例开发资料](2026-10-04-legacy-instance-import.md)：同一原则——源只读、目标离线、保留原 ID 与来源身份、fail-closed 的跨实例来源——在两个方向保持一致；开发导入记录中「为个人侧迁移预先抽象」的边界由本记录收尾：复用其导出辅助，各自保留方向模块，不建通用引擎。
- [显式访问模式](../feature/2026-09-19-explicit-access-modes.md)的技术权限边界：凭据复制限平台交接必需的最小集合（平台绑定 + webhook），其余服务凭据不复制、缺绑定即停用；长期授权不在导入侧放宽，全部交给使用侧既有核实。

## 备选方案

直接用源快照整行 sha 与目标行比较，可用一套哈希识别同源项；但收尾转换含 closed_at/settled_at 等时间戳，目标行已不是源快照行。按[工单 22](../../../../.scratch/agent-direction/issues/22-migrate-personal-instance.md)「与计划的实施差异」，同源已导入的唯一证据改为 applied 回执的转换后 manifest，匹配才跳过，其他同键仍拒绝。

把凭据复制动作纳入修订可以把动作也固定在预览；但复制后中断再跑时动作变成 skip，会永远触发 revision_conflict。该工单明确从修订剔除动作，凭据同名异值冲突仍在应用期核实，不放宽凭据覆盖边界。

## 后果

个人资料、平台钉版、偏移和活动调度随同产品延续，保留 ID 让应用审计、来源、授权和发送引用不断链。代价是目标必须全新，旧实例不得再次消费同一平台和调度；源保持只读，导入不代为停用它。必要凭据只迁移平台与 webhook 最小集合，服务凭据缺失仍停用；目标任何新增发送、调度或运行时行改写均阻止回退，不能用旧备份抹掉切换事实或重演副作用。

## 验证

历史实施证据见[工单 22](../../../../.scratch/agent-direction/issues/22-migrate-personal-instance.md)：test/86-personal-instance-import 5/5、相关回归、typecheck 和图解检查通过；当时全量 894 项中 890 通过，3 个既有环境项（DNS、目录名、test/83 并行负载，隔离 13/13），其余门控跳过。smoke-22-migrate-personal-instance.mts 在 macOS 与 ssh tx Linux 各 6/6，进程、socket、SQLite、JSONL、文件锁与 0600 凭据为真实环境，模型和 Telegram HTTP 为 stub。验证 offset=101 接续、逾期运行恰一次、旧 pending 零外发、同源重跑和回退阻挡。

本机真实旧实例完成预览、应用、启动查阅和干净回退，源 52 个文件哈希树不变；该实例无平台配置/调度/记忆，交接以逻辑测试和冒烟覆盖。tx 真实数据原实施未实测。运行步骤、旧实例停用要求与手工恢复见[操作手册](../../../../docs/usage.md#6-导入旧实例)「旧实例个人资料迁入」。

## 适用范围

通用调度的独立执行、运行归属、审批来源与整项取消采用[本决定](../feature/2026-10-12-generic-scheduled-tasks.md)；本篇其他独立规则继续适用。
