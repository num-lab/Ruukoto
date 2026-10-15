# 03 最终非作者区域独立实现审查

结论：本次明确审查的非作者区域通过，未发现剩余工程阻断；不替代 05 的真实模型与产品验收。对象是主工作区最终未提交代码，输入文件 SHA-256 见 `snapshot-final-nonauthor-review-inputs.sha256.json`。直接依据 `.scratch/subagent-roles/spec.md` 的 R5、R9–R11、R14、03 工单和最终代码判断；作者总结仅用于定位。

最终冻结清单 `.scratch/subagent-roles/evidence/03-production-inputs.sha256` 的 38 项已逐项在主工作区重新计算，38/38 完全匹配；清单 SHA-256 为 `4d4080f7821db32e9f2217a0394603932167599bef2afe53e1c404a195e56ed7`，逐项记录见 `snapshot-final-nonauthor-production-freeze-verification.json`。后补 execution 图、APFS 安全拒绝说明以及来源对象只读借用/私有持久闭包表述均已直接核对，与代码和实际反证一致，未因此重复生产测试。

本审查覆盖普通宿主身份与来源绑定、Runtime/HostExecution 停止及占用、ToolRouter 来源保护、Orchestrator/ParentDelivery 恢复与送达、schema 44、两方向导入、工作流 snapshotDigest 接线，以及后来由其他作者实现的 native file bind 与大小写/路径形态补丁。本人曾实现 split-index 私有读取、索引/阶段条目认证、stage-only blob 闭包、便携来源对象读取及空模板/SHA-1 初始化；这些作者 hunks 明确排除，不由本报告独立批准，交由 contract_audit 的交叉审查。文件整体哈希包含排除部分，排除清单另存于输入清单。

## 发现与独立复核

1. 普通结果在合法 write_target JSON、真实私有基线文件被删、无 agent_wait 和无 AgentReport 时，会绕过仅验证报告的路径。原始真实捕获反证中 main 建立并准入 wake、dev 注入 completed 结果，verifyAgentReport 未被调用。最终 mandatory verifyWork 进入普通 workUnavailable/reserveResult，Runtime 接入 subagents.verifyWorkspace；独立修复复核四种新交付均阻断，原 completed 任务和旧结果保留。将该依赖改为 no-op 的独立红验重新出现全部四种错误交付。
2. dev 父级 pending 消息最初没有与结果共用基线预检，真实基线被删后仍写入 deliveredAt 并送进注入。最终取消息时核实工作、保存具体 undeliveredReason，正文保留、deliveredAt 为 null；同事务且仅首次变更追加既有 subagent_message.dropped 事件。独立 probe 与新增真实 Runtime 回归均通过。
3. 冷补记不能只靠 ParentDelivery 阻止 wake：Orchestrator 必须在制作结果/交付产物前核实真实基线。最终冷补记保存 failure=snapshot_corrupt、结果 outcome=failed，原 Task.status=completed 不倒写，不制作坏交付产物、不重跑模型，健康工作继续。仅撤去终态 verifyWorkspace 回调后，反证恢复伪 completed 结果和坏 resultData 调用，即使送达层仍能挡住 wake。
4. 大小写与文件/目录转换的修复不再把旧 HEAD 路径并入当前内容。冻结用捕获树建立私有索引枚举新文件，旧路径只是已删除的占位；实际文件名按原始文件系统名字收敛，literal symlink 不被 realpath 跟随，旧后代路径遇到已登记的最终替代节点可以判为缺失。独立 8 个新用例核实初始 staged case、两种源 D/F、三种子副本 D/F/link、嵌套 Git/gitlink；额外反证核实源仅更改名字大小写也冲突，源父目录后改符号链接时拒绝并保留来源和外部字节。
5. native 的所有普通文件先按 dev/ino 核实读写等级，nlink=1 file bind 不再漏过；原目录身份去重和硬链接条目闭合保留。宿主文件入口正向核实保护树内子对象身份，不跟随符号链接，目录 inode 去重防止挂载循环；逆向授予祖先检查不增加全树遍历。主工作区相关 core 用例独立 2/2 通过。真实 Linux bind 工程证据由 native_probe 持有，本审查没有把离线替身当成该实测。

普通宿主操作持有独立 null-model Task、账本与单元身份，核实真实父任务、来源权限版本、源目录身份和占用；停止未核实保留来源与副本占用，较晚结束的宿主账本不替代 Agent 最终回复。schema 44 保持严格版本拒绝；两方向导入核实保存的快照/宿主来源，不补造 HEAD 基线；工作流冻结、验证证据与汇入均绑定同一 snapshotDigest。execution.md 的 capture/private 原始树 → 独立宿主 Task → no-checkout 登记 → 原始物化图、write_target 表和显式只读 inode 边界已与最终代码核对。

## 独立执行记录

| 命令与对象 | 结果 | 原始输出 |
| --- | --- | --- |
| `npx tsx --test test/work-copy-host-core.test.ts test/work-copy-host-runtime.test.ts test/workspace-snapshot-runtime-boundaries.test.ts test/workspace-snapshot-terminal-boundaries.test.ts test/125-agent-wait.test.ts` | 当时 29/29 | `snapshot-final-nonauthor-host-delivery-tests.log` |
| `npx tsx --test test/85-legacy-instance-import.test.ts test/86-personal-instance-import.test.ts test/112-workflow-real-steps.test.ts` | 24/24 | `snapshot-final-nonauthor-import-workflow-tests.log` |
| `npx tsx --test --test-name-pattern='无等待报告\|冷补记真实 private' test/workspace-snapshot-runtime-boundaries.test.ts` | 最终新增 3/3 | `snapshot-final-nonauthor-new-runtime-tests.log` |
| `npx tsx --test --test-name-pattern='已暂存的大小写\|子副本\|已暂存的 file-to-directory\|已暂存的 directory-to-file\|实际嵌套' test/workspace-snapshots.test.ts` | 最终主工作区 8/8 | `snapshot-final-nonauthor-case-main-tests.log` |
| `npx tsx --test test/subagent-execution-core.test.ts` | 最终主工作区 2/2 | `snapshot-final-nonauthor-filebind-main-core-tests.log` |
| `npx tsx /tmp/snapshot-final-nonauthor-delivery-probe.mts` 与 `PROBE_VERIFY_WORK=0` | 实际基线缺失；修复阻断、撤回回调红验 | delivery/message 的 probe、fixed、red JSON 与日志 |
| `npx tsx /tmp/snapshot-final-nonauthor-cold-probe.mts` 与 `PROBE_COLD_VERIFY_WORK=0` | 冷补记修复与独立撤回终态回调红验 | `snapshot-final-nonauthor-cold-fixed.json`、`snapshot-final-nonauthor-cold-red.json` |
| `npx tsx /tmp/snapshot-final-nonauthor-case-extra-probe.mts` | 最终主工作区三种真实额外反证通过 | `snapshot-final-nonauthor-case-extra-main.json` |
| `npx tsx /tmp/snapshot-final-filebind-cost.mts` | 62,985 文件/6,370 目录；负向宿主保护检查 278.4/278.3/280.1ms | `snapshot-final-filebind-cost.json` |

失败证据没有删：新增冷补记夹具最初用过长前缀触发 macOS Unix socket EINVAL，导致测试初始化失败；缩短到 snap-cold 后定向 3/3 通过。初版 case 7 用例为 5 通过、2 失败：case-only 子改名的自动套用断言超出 Git 在 APFS 的能力，nested/gitlink 夹具直接抛 execFile Error 而未按真实脚本 wire 核实；保留日志，最终拆分明确语义并按 wire 断言后 8/8。额外父链接反证原先预期 snapshot_changed，实际命令替换边界包装为带 code 的 integrate_failed；错误仍明确父目录变化，来源与外部均零写，最终记录如实保留该代码，不将它记作普通 applied/conflict。

## 范围与实际限制

APFS 上子成果仅改变名字大小写时，真实 99-byte 冻结增量完整保留；stock Git apply --check 和宿主同样因 already exists 拒绝，source/index 与副本无写入，具体 Git 诊断随 conflict 返回。R10 约束当前内容与子增量，计划允许汇入预检失败保留双方，未承诺所有重命名都能自动套用；因此这是明确保留的 Git 套用限制，不阻断 03，也没有新增自定义源重命名协议。若用户需要该成果，须在后续产品流程核对保留副本。

宿主非关联目标的身份保护新增 O(保护树) 成本，本仓约 278–280ms/检查；不用缓存以免沿用旧别名。仅凭 inode 检查不能承诺抗宿主外部特权的原生全局保护根场景，既有未显式只读挂载反例已在工程记录另列，不纳入本报告的通过范围。

未检查：本人作者 split/index/stage 闭包 hunks 的独立批准、独立重跑 Linux bind、真实模型与 05 联合产品体验；全仓 check 未运行。主工作区全量静态/build 与其余双平台工程结果由 root/其他独立记录持有。
