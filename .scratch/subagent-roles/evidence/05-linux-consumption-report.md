# Linux 来源消费与调用方收口

生产对象为 `5f9da455072d68180ef19fc92ad02070cea583c1` 加目标摘要补丁 `011f10bc216f4b9d8052397ab0f473fc75186d19eb17a59a7fff502204c68d71`、来源消费候选 `24dc9c1c746113f276ca10502626be122210532eefd7e555e7903f06d28c3f93`。三文件调用方夹具最终补丁为 `f054b6e1fe2691d9cbd78224dbaad3c13502aab9034f6a0386fd46b3ad317b13`；从第一版补丁追加的消息绑定增量为 `f7ba27b1101170dfe5ae82541bf9fe719669d8ffb1017f8b0318a5fc4a333a99`。

Linux 环境沿基线：UID 1003、Node 24.21.0、Git 2.43.0、正式 native 前置。模型均为本地 mock，Runtime、Driver、SDK、SQLite、Git 和工具实际运行；消息渠道使用测试替身，没有发送真实 IM 或访问真实业务平台。

最终串行消费组合为 12 文件：新增 `subagent-result-source-boundaries`、88-parent-delivery、92-subagent-lifecycle、115-workflow-final-delivery、125 的 report/attention-report/recovery/group-boundaries、workspace-snapshot-terminal-boundaries、45/46 GitHub、86-subagent-messaging。`source-consumption-final.command.json` 保存完整原命令。121/121，失败、取消、跳过均为 0，退出 0；外层 122.870917 秒，Node 122.363001 秒。起止 03:36:33.555–03:38:36.426 UTC。没有修改 timeout、添加 retry 或重跑此组合。

组合开始与结束的 617 项普通源码和测试输入逐项 SHA 全部一致，见 `final-source-before.json` 与 `final-source-after-consumption.json`。本轮实际 agent/runtime/core/channels/control/apps 与根依赖清单 157 项另与主仓比对，157/157 相同；TUI 演示夹具不属于本组合执行范围。

随后只追加作者提供、已独立审查的恢复夹具补丁 `5482cbaef0ad53a8949d617f4427d7892ad75ffeb82305730bebebe8715be94e`，修改单一 `test/86-subagent-recovery.test.ts`。从真正 GitHub 固定评审入口建立事件、来源父轮、固定角色和排队任务，替代在已运行 general 身份中途覆盖定义的旧夹具。整文件 5/5、0 跳过、退出 0，外层 12.209869 秒；起止 03:40:51.743–03:41:03.953 UTC。其后 617 项中仅此已知测试文件与 121 组输入不同，生产代码没有变化，见 `final-source-after-recovery.json`。

调用方旧夹具的红绿均保留：

| 检查 | 原始结果 | 修正后 |
| --- | --- | --- |
| 86-messaging 整文件 | 4/8；旧只读工具期望及三个缺 execution 的 busy 任务 | 首轮目标补丁环境 8/8；最终来源组合另覆盖实际完成和唯一调用 |
| 41-qq-private-scope | 0/1；手工任务引用使用空 sha256，先触发记录损坏 | 1/1；补真实 endedAt/hash，保留原授权拒绝断言 |
| 84 非 IM 来源窄例 | 0/1；未授权 internal 事件的委派被 source_forbidden 拒绝 | 1/1；保留 TUI/dev 可委派、不附汇报及零发送，并断言 internal 拒绝、零新增工作和身份；叠来源候选后再验 1/1 |
| 22-auto-review 原文件 | Linux 原断言 17/17、0 跳过 | 未改用例 |
| 目标摘要补丁 | 单列 8/8、0 跳过 | 未混入 73 项原基线 |

86 第一版只补 readScope，在叠加新来源校验后虽显示 8/8，却输出 execution_binding_invalid，实际消息任务可能失败。加强幂等例的 completed 与 CAP-Q 模型恰一次断言后，保留缺 parent 的状态产生真实 0/1 红：actual failed，expected completed。最终三个 busy 任务同时沿原 join/A Task 保存的 parentTaskId、sourcePermissionVersion、readScope 播种，以上 121 组合中的 86 全部通过；没有放宽生产校验或删除权限、取消、幂等、来源和发送断言。

消息工具集合与 B 首次执行固定的 execution.tools 逐项比较，另明确包含来源允许的 bash；不再使用旧派发模式的固定三工具假设。恢复及绑定修正均为测试夹具同步，最终是否可接受由独立审查记录持有。

121 组合中 SSH 静默通道被远端关闭，客户端为 255；原独立 runner 未被重启，最终命令结果来自其落盘的实际子进程退出 0。该传输故障单列，不能据客户端连接状态改写测试结果。原日志、两个版本、明确红例与完整参数均保留；完整 `npm run check` 另包记录，本文不提前宣称其通过。
