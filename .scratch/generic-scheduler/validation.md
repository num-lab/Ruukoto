# 通用定时任务验收

2026-10-12。与[完全访问验收](../full-access/validation.md)联合完成，最终应用检查 1154 通过、1 跳过、0 失败，静态检查与构建通过。完整命令、真实平台范围、施工中间失败和未验收项由该报告持有。

`npx tsx --test test/51-generic-scheduler.test.ts` 的[原始生命周期输出](../git-history-cleanup/archive.md?path=.scratch%2Fgeneric-scheduler%2Fruntime-lifecycle-tests.log)为 9/9：覆盖整项子任务与协作汇总、模式固定及主聊天并行、排队根任务与汇总按原键恢复、绑定事务回滚、取消排队与全部派生任务、未核实占用阻止关闭／重叠、取消自身计划的成功与未核实停止。最终应用检查还覆盖时间规则、outbox、IM 审批、业务工具、固定目标、跨平台隔离与当前格式实例导入。

模型、IM 和服务均为离线替身，Runtime、SQLite、JSONL、文件及操作账本实际运行；没有验收真实消息平台推送或真实模型。计划正文不能提升模式或扩大固定目标；已开始但效果不明的操作不自动重做，主动脱离进程与外部服务不承诺回收。
