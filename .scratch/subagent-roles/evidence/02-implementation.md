# 来源能力与上下文工程证据

实施日期 2026-10-15，基点 `d12eb6329da9fd9128989ef0725ce1243627068d`，分支 `Eitrous/subagent-roles`；起始工作区干净。要求见[工单 02](../issues/02-source-capabilities.md)、[规格](../spec.md)和[方案](../implementation-plan.md)。root 是汇总工作区唯一写入者，Driver/上下文与 MCP/资料测试在独立工作副本完成后汇总；独立审查由另一个执行上下文承担。未提交、推送、部署或改日常实例。

## 实际交付

普通委派与真实工作流步骤在可执行 Task 登记前预检并持久化来源、角色摘要、有效工具、访问模式、保护约束及 MCP 签名。主 Agent 的受控编码资格可派发 shell，子任务仍是独立 SubAgent/Task/Session；个人业务审批、回执与账本归实际子任务。显式缺工具或发现失败不留下可运行任务，省略工具继承实际集合，发送、调用、批准消费及冷恢复继续复核来源。

普通默认角色只给 request/key 即可在独立目录实际执行 bash；两产品与工作流默认步骤的基础工具一致，普通工作内消息按生命周期另行提供。项目指令、技能与角色正文可由落盘选择记录、prompt 产物及 JSONL 重建；不复制父聊天或自动个人记忆。普通 memory_list/read 读取 ID 与事件持久化，后续复用核实所有旧来源及已读记忆，拒绝用新配置继续发送失效旧正文。资料解析钉定 grant IDs，异步预检期间的新授权不能扩大范围。

权限只继承或收紧。消息续投先取原实际模式与发送者模式的收紧交集，再应用固定角色；完全访问消息不能提升原 confirm 的受保护继承角色。protect_source 要求 native，拒绝完全访问、原地目标及重叠工作目录，结构化与批准后的宿主写入同样拒绝来源和多硬链接。冻结验证仍由宿主强制 confirm、保护及固定工具约束。GitHub hostReview 保留已完成来源资格、固定只读 MCP/禁消息和恢复语义，不套普通工作流活动来源前提。

新增快照随两方向导入校验；损坏 scope、来源引用或读取记录拒绝猜测。schema 从 42 升到 43，按现有政策拒绝旧库，不回填角色或授权。行为及取舍已同步[决策笔记](../../../.agents/notes/implemented/architecture/2026-10-15-subagent-source-capabilities.md)和 agent-tools、agent-context、runtime、execution、core、workflows、scheduler 模块文档。

## 检查与返工

下表是实际批次，不累加重复用例。定向用例使用 npx tsx --test，文件名完整指定；检查均在 macOS 本机，真实模型默认关闭。

| 检查对象与文件集合 | 结果与证据 |
| --- | --- |
| npm run check:static；npm run build | 均通过，见[静态](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-static.log)、[构建](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-build.log)。静态包含 lint、根及 workspace 类型、笔记、文档门禁；最终静态在最后代码与夹具修订后执行。 |
| 45-github-events、46-github-recovery、62-tool-availability、81-subagent-reuse-close、83-subagent-worktrees、111-workflow-capabilities、113-workflow-source-capabilities、subagent-source-capabilities、subagent-capabilities、subagent-execution-core | 99/99 通过，见[交付回归](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-delivery-tests.log)；最新消息和导入增量另见下两批。 |
| subagent-source-capabilities、86-subagent-recovery、92-subagent-lifecycle、51-generic-scheduler | 最终 61/61 通过，见[消息与生命周期](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-message-tests.log)。包含双产品真实 bash、业务归属、显式工具/MCP 缺失、资料/配置撤销、快照损坏、记忆撤销、旧 MCP 结果、消息收紧和取消。 |
| subagent-execution-core、94-task-ending、106-workflow-host、108-workflow-import、109-workflow-cold-recovery、110-workflow-workcopy | 46/46 通过，见[存储与恢复](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-storage-tests.log)。该批误写的不存在导入文件名未提供覆盖，实际导入补在下一批，不能据此宣称导入通过。 |
| 85-legacy-instance-import、86-personal-instance-import、125-agent-wait-import | 26/26 通过，见[两方向导入](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-import-tests.log)。 |
| 105-workflow-runtime、83-subagent-worktrees、86-subagent-recovery、subagent-capabilities、subagent-source-capabilities | 83/83 通过，见[预检与停止恢复](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-preflight-recovery-tests.log)。迟到预检不创建 Task、不访问停机后的库；工作副本与占用保留原语义。 |
| 107-workflow-runtime-wiring、112-workflow-real-steps、subagent-capabilities | 最终 17/17 通过，见[真实工作流步骤](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-workflow-tests.log)。使用真实 Driver、Git、worker、文件和 macOS native 冻结验证；模型应答由 mock provider 驱动。 |
| core 生命周期 01/03/04/05、上下文 16/18/56/60/61、105/107/112 与 agent_wait 报告/恢复相关用例 | 初次 180/183，见[原始批次](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-core-context-tests.log)。107 的旧手工任务缺执行快照，112 的无目标步骤旧断言及冻结验证漏 hostVerify 已修；受影响 107/112 在上述 17/17 中通过。其它已通过部分不重复跑。 |
| 审批/工具 07/08/10/63/64、control 66、恢复/结果 86/92/91/88、IM 审批 77、scheduler 37/51 与 101-native-execution | 初次 182/183，见[跨层原始批次](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-cross-tests.log)。唯一失败是取消来源被记为 source_invalid；已恢复 work_canceled 分类，51 与新来源用例 24/24，见[取消修复](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-scheduler-tests.log)，最新完整消息批 61/61。 |
| 导入 85/86、复用 81/82/92 与 agent_wait 等生命周期相关用例 | 初次 93/94，见[生命周期原始批次](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-lifecycle-tests.log)。81 对撤销仅等待 interrupted，实际可在首次发送前 failed；修正夹具为两种合法阻断终态，最终 99/99 包含该用例。 |
| git diff --check；npm run change-scope -- --base d12eb6329da9fd9128989ef0725ce1243627068d；笔记锚点检查 | 通过，见[范围](02-change-scope.json)、[锚点](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-anchors.log)。锚点无悬空，已有未被代码引用笔记仅作报告。 |

中间失败未记作通过。独立审查另用负例确认：读取记录缺失、未知资料引用、旧 MCP 上下文、冻结验证调用门、预检停机竞态及 SDK cwd 更新；完整结论见[实现审查](../02-implementation-review.md)。实际工作目录变化时销毁旧 SDK 并更新 cwd 身份，保留原 JSONL 历史，对应最窄 Driver 回归在未修代码上失败、修复后通过；该回归只切换到新的子目录，不以此证明 Git 副本准备。

## 模型可见文本估算

使用真实 Driver/SDK、mock provider 与选择记录的 estimates；[探针](02-metrics-probe.mts)和[基线](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-metrics-baseline.log)/[当前](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F02-metrics-current.log)留存。两产品均为 dev 来源、general、full_access。普通比较用相同 readPaths 为 [.]，因为改前无资料默认入口会被拒；工作流默认步骤只给正文。独立副本临时恢复基点的四个 agent 文件及脚本构建进行比较，随后恢复；它比较实际模型输入，不是旧基点的完整产品验收。

| 产品 | 入口 | 改前 systemPrompt | 改后 systemPrompt | 改前 toolSchemas | 改后 toolSchemas |
| --- | --- | ---: | ---: | ---: | ---: |
| ruukoto | 普通 | 846 | 894 | 926 | 4773 |
| ruukoto-code | 普通 | 846 | 894 | 926 | 4773 |
| ruukoto | 工作流 | 1071 | 1071 | 3629 | 4268 |
| ruukoto-code | 工作流 | 1071 | 1071 | 3629 | 4268 |

普通工具由 3 个增加到 17 个，新增编码、历史/记忆、搜索和技能工具；工作流由 12 个增加到 16 个，新增 edit/write/bash/request_file_access。该比较使用 dev 来源，没有 app_data/scheduler/service；普通额外一个 subagent_message。数值受 cwd 文本长度与 CJK 校准估算影响，不使用模型 tokenizer，不能当真实模型费用；父角色目录未改。

## 验收边界与交接

本单完成来源能力及执行门的工程接线。个人 app_data、MCP 发现与通知入口使用平台替身，只证明宿主身份传播与真实子 Task 账本，不记外部业务成功。protect_source 的策略/文件工具与旧冻结验证实际 native 负例已核实；脏目标捕获、当前内容副本基线、共享 Git 写旁路及双平台完整证明由 03/05 持有，不据本单旧 HEAD 副本用例宣称通过。

新 target/role/verify 接口及旧 mode 拒绝属于 04，当前接口尚未替换。下一实施入口为 03，先完成机制实验；05 承担真实模型、外部 IM/MCP、Linux/macOS 联合隔离与产品体验。未跑全量 npm run check，未启用真实模型，未触碰匹配旧版本的档案或历史。工程审查不授予提交、推送或部署权限。
