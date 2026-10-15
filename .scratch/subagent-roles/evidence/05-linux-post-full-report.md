# 工单 05 Linux 完整检查后的夹具与等待诊断

原完整检查 v1 的 1640 通过、5 失败、13 跳过另存独立归档，不被本轮结果替换。随后先按原 v1 源码独立执行 foundation（9 通过、1 真实模型跳过），再应用三条已独立审查的 test-only 夹具补丁，得到官方 v2 清单 `bbc326d0109e58fc4ffc2f088502b286a9e268c9f969d7a09a65b5d33d8ac507`。v2 的 620 项在窄复核前后全匹配。

| 独立命令 | 实际结果 | 外层秒数 |
| --- | --- | ---: |
| test/10-access-modes，assertGrantNotProtected | 1/1，0 跳过，exit 0 | 3.398 |
| test/125-agent-wait-resource，父级注入 | 2/2，0 跳过，exit 0 | 6.295 |
| test/14-tui-app，原长正文重连窄例 | 1/1，0 跳过，exit 0 | 7.308 |
| test/122-workflow-code-acceptance，原正式 90 秒整文件 | 0/1，0 跳过，exit 1 | 109.045 |
| test/84-im-final-delivery，目标变化窄例 | 1/1，0 跳过，exit 0 | 5.894 |
| test/14-tui-app，一行精确分页等待后 | 1/1，0 跳过，exit 0 | 7.106 |
| 122 独立临时 180 秒诊断副本 | 1/1，0 跳过，exit 0；仅为诊断 | 129.295 |

10 改用自己创建的保护根、父目录与无关兄弟目录，避免遍历真实生产保护目录。125 保留直接测 Driver 的窄边界时，同步替换来源复核桩，实际 Runtime 来源拒绝仍由其他严格用例覆盖。84 的来源停用在模型前取消唤醒、保留子结果且零 selection/模型/outbox；发送前重新配置仍取消且新目标零发送。14 只等待原先精确的后续 48KiB 分页请求条件，完整正文、唯一性、分页与滚动断言全保留。四处补丁没有改生产门。

v2 原 122 单跑仍在原 90 秒报告等待到期，完整快照显示 change1–5 completed、change6 failed；verify1–5 completed、verify6 skipped；merge 与其宿主 Task running，无 task.error，run 的 usedMs=104352、stopUnverified=false、effectUnknown=false。原 full 较早到期时仍有验证运行/排队。两次原预算红均保留。

14 修后得到官方 v3 清单 `df4176d083a6891658fe0144e43096ec94b689b0ac46ca30a66102beb8a21bcd`，仍 620 项，仅比 v2 多一行测试同步修复。实际完整源码归档 `post-full-v3-source.tar.gz` SHA-256 `d460c789464ada88888fb45d6de91b82807df23ae1d3d1246de2eebde4c99d8a`，本地逐项回读 620 个成员字节/链接目标全匹配官方清单。

在 v3 固定后按明确授权做一次有限等待诊断：正式 122 文件始终保持原 SHA-256 `c63bb044653707976184b582aa3612bbecdee0398a1e2b1cf708f91becab16aa`，另建同目录的 `122-workflow-code-acceptance.180-diagnostic.ts`（不匹配正式 *.test.ts）。独立副本仅将报告等待 90_000 改为 180_000，并记录该 wait 的 performance.now 单次前后差，其余三个实际共享名额、冻结成果、全部字节、账本、唯一报告与停止断言不变。完整差异、准备脚本、原正式源码与诊断源码均保留。

04:26:18.586–04:28:27.882 UTC，诊断唯一一次执行退出 0，全部原断言通过。原 stderr 记录 `reportWaitMs=110375.362817, reported=true, limitMs=180000, formalLimitMs=90000`；报告实际等待 110.375 秒，超过原截止 20.375 秒。用例 125.932 秒、命令 129.295 秒。诊断后官方 v3 的 620 项仍全匹配，未覆盖正式 90 秒文件，未把诊断绿算成正式全量通过。

原始增量传输包 SHA-256 `861c3733b488becb610b7ae2d45c3690403a2c264d9d4c5441efef81a580aa1e`，34 个原始成员全部本地回读通过。确认保存的诊断字节匹配后，仅删除仓内这个自建诊断文件，仓外备份与所有日志保留；单项清理记录附。随后正式等待校准及第二轮完整检查另列输入与结果。本轮没有真实模型、真实 IM、部署或系统配置改动。
