# 当前工作区快照独立实现审查

结论：2026-10-15 工单 03 工程审查通过，无未解决阻断；产品与真实模型联合验收保留给 05。实施者为 root 及三个独立工作副本，审查直接读取[规格 R5、R9–R11、R14](spec.md)、[工单](issues/03-workspace-snapshots.md)、计划第三节、规则、实际代码/调用方/文档与原始证据；作者总结只作导航。

[生产及测试清单](evidence/03-production-inputs.sha256)固定本单 38 项，SHA-256 为 `4d4080f7821db32e9f2217a0394603932167599bef2afe53e1c404a195e56ed7`。snapshot_probe 逐项重算 38/38，native_probe 在最终 Linux 副本逐项核实 38/38；双方没有改变主仓代码。最终完整[输入清单](evidence/03-implementation-inputs.sha256)固定 69 项要求、规则、实际文档/笔记和[工程记录](evidence/03-implementation.md)，清单 SHA-256 为 `5b09ef80283485bbd9b8c5509a72ee4ee6782743dc8ea967f988fc34674066a4`；排除自身、本汇总、原审查报告及状态交接，避免循环摘要。接手前 02 原文、03 独立补丁及 54 项实际重建证明由工程记录持有，不把整个未提交 diff 当作本单新增代码。

## 独立与覆盖

| 审查者与原记录 | 独立覆盖 | 作者部分的交叉归属 |
| --- | --- | --- |
| `/root/snapshot_probe`，[审查正文](evidence/03-snapshot-review.md)、[输入](evidence/03-snapshot-review-inputs.json)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F03-snapshot-review.tar.gz) | host Task/来源绑定/停止占用、Runtime 队列/消息/恢复、Orchestrator/ParentDelivery 实物门禁、schema/双向导入、workflow snapshotDigest、native/宿主 file bind、大小写与 D/F/link 路径修复及文档 | 自己编写的 split-index、索引认证/阶段 blob 闭包、promisor 只读视图与模板/SHA-1 hunks 排除，由 contract_audit 独立审查 |
| `/root/contract_audit`，[审查正文](evidence/03-contract-review.md)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F03-contract-audit.tar.gz) | 原始捕获/完整来源零写入、私有对象与 staged blob 闭包、split-index、promisor/模板、完整受影响字节门禁、symlink 配置修复及 execution 文档 | 自己编写的 host/runtime 绑定与大小写/D/F 路径 hunks 排除，由 snapshot_probe 独立审查 |
| `/root/native_probe`，[最终 Linux 报告](evidence/03-linux-final.md)、[原始包](../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F03-linux-final.tar.gz) | 最终真实 Linux build/Runtime/native/scope/Git2.43/等待与非 Git，源码运行前后同一冻点 | 自己编写的终态/父送达与 file bind 修复不自授独立通过，由 snapshot_probe 阅读和负例复核 |

共享文件整体哈希包含作者与非作者 hunks，独立批准按上述实际改动归属判断。所有生产改动均有非作者上下文核对，不以作者测试或 fixture 平台替身代替独立审查与真实环境证据。

## 阻断闭环

原方案中私有 index 使用源 alternates 的实验刷新 399 个源 loose object 时间，已弃用。独立复现的 split-index 读取刷新共享索引、promisor 自动下载、模板 alternates 继承和仅 staged blob 缺失仍可恢复/冻结均已修复；相同机制重验分别证明源状态不变、缺对象拒绝及持久阶段闭包完整。私有 Git 不依赖来源 alternates，新对象只写私有库，来源对象在不加载 remotes/config 的只读视图核实。

来源 Git 指向变更、私有对象 symlink/hardlink/commondir、缺对象以及 core.symlinks=false 汇入改变真实类型已闭合。当前路径捕获不混入 HEAD 过期名字，实际大小写及 D/F/link 正反例通过，nested Git/gitlink 仍拒绝。完整同文件不同 hunk 后改也先拒绝，子增量不重套原有脏内容，无关文件不阻塞。

普通无 AgentReport 的 main wake、dev 结果/消息注入和冷补记原可绕过物理基线核实；最终 mandatory verifyWork/verifyWorkspace 在各持有层拒绝，独立撤回回调可重新触发红验。失败结果记录具体 code，已完成 Task 与旧结果不倒写、不重跑、不补造报告，消息掉落事件同事务且仅写一次。真实坏基线不影响健康工作。

Linux nlink=1 file bind 曾绕过原生文件检查和批准后宿主入口，修复后显式来源只读对象别名均拒绝；目录 inode 与已有硬链接闭包保持。来源/shared Git/私有基线/materials 与副本检查产物的读写区别由真实 worker/文件字节核实。未核实停止继续保留实际 Task 身份和双方占用。

## 审查者执行与证据界限

snapshot_probe 执行非作者 host/送达 29/29、实际导入/工作流 24/24；最终新增实际 Runtime 3/3、路径 8/8、文件 bind core 2/2，并独立运行真实基线删除的交付/消息/冷补记正反探针。contract_audit 执行非作者核心机制 12/12，四个真实机制原反例与最终修复逐一复核。路径作者 55/55 和撤修 7/7 红另保留，不算独立通过；最终路径独立 8/8 持有该结论。

最终 macOS 53 项首次 52 通过、1 个 reviewer 等待超时；不改用例或超时，单独重跑 1/1。最终 Linux 五文件首次 42/43，唯一 child mock Connection error；原文件顺序重跑 4/4，额外诊断 1/1，没有复现原错误，原 SDK cause 已随标准 fixture 清理无法恢复。两次首次原因仍未知，原日志保留，不能称首次全绿或确定只是资源问题。最终 Linux 394 输入运行前后及主仓冻点一致，真实 scope 停止、来源拒写/file bind、Git2.43 promisor、非 Git 与 agent_wait 通过；快速退出及入口前失败仍准确返回 stop=false。

主仓最终 `check:static`、build 与定向组结果由工程记录持有。实际 SDK 模型输入量化沿 before=03 接手前/after=最终代码，完整输入和选择 estimates 留原日志；所有模型回答是离线 mock。五份机制/审查/Linux 归档的内部 SHA/长度逐项复核见[归档清单](evidence/03-archives-verified.json)，没有删除原始失败。

## 保留限制与交接

APFS 仅大小写重命名的非空子增量被 stock Git 套用预检以 EEXIST 安全拒绝，保留来源/index/副本及具体原因；大小写敏感 Linux 可套用。这符合预检失败保留成果的计划，不增加自定义源回写器。宿主保护遍历本仓约 278–280ms/次；未显式只读挂载的原生全局保护根仍有外部特权预存 bind 的既有缺口，实际反例另列，不纳入本单通过范围。

03 转 ready-for-human，01–03 的工程前置成立，04 转 ready-for-agent；04 尚未实现新 role/target/verify 接口及旧 mode 拒绝，05 尚未完成真实模型、外部 IM/MCP/个人业务和组合产品体验。本次未跑全仓 check，未提交、推送、部署或修改日常实例。schema 44 仍严格拒绝旧档案，私有基线不迁移、不自动清理；源写入与 SQLite 不承诺跨文件系统原子性。

最终交付元数据再由 contract_audit 只读核实：69/69 完整输入与 38/38 生产项逐一匹配，两个清单摘要正确；工程记录、两次首轮失败/独立重跑与未知原因、03/04/05 状态及计划交接均准确，无虚假通过或越界结论。此轮未改代码或重跑生产测试。
