# 原子发布个人后台认证令牌

Status: ready-for-human

当前环境验收范围沿[06](06-node24-ci-budget.md)的 Node24 双平台和 90 分钟 job 预算；本工单已有 Node22 反例保留为历史证据。

## 目标与边界

[测试精简](02-reduce-test-suite.md)的完整 macOS 运行发现 `personal-entry` 的重启/信号用例抛 `control_token_invalid`，随后失败清理留下后台和监听。本工单按主工单要求独立处理产品缺陷，保持认证、档案格式版本和逐启动轮换语义，不以重试坏令牌替代修复。

## 方案

`startPersonalServer` 持有原档案锁，仍先调用 `readPersonalToken` 拒绝坏旧令牌；新令牌先以 0600 写入同目录 `control.token.tmp`，完整写入后 rename 到 `control.token`。沿现有配置临时文件模式，在档案允许列表中加入这个普通文件；残留临时文件不作为认证来源。首次发布前读取可报告原有 `control_unavailable`，轮换过程中读取只能见到完整旧值或新值。文件写入/替换失败沿既有 `control_start_failed` 向上报告并释放实例锁，不改变 HTTP 错误或客户端重发规则。

`personal-entry` 的局部清理按子进程、模型替身、目录顺序执行；每项失败仍执行其余清理，最后报告全部失败。保留真实 bin、SIGTERM/SIGHUP、锁释放和坏档案拒绝断言，不增加通用测试框架。

## 验收

- 受控停在创建/截断和写入之间：原首次与轮换读取失败，候选只看到缺失或完整令牌；发布后可用、权限 0600，旧坏令牌仍原字节拒绝，残留 tmp 可恢复且不被用于认证。
- 在真实后台仍运行时注入用例失败，清理仍停止自有子进程、关闭模型替身、删除临时目录；清理项本身失败也不跳过后续项。
- 独立审查认证拒绝与档案允许列表，定向跑 `personal-entry` 及实际调用方用例，再按主工单执行完整检查；Node24 双平台结果仍由主工单持有。

## 进展与交接

独立方案审查由 linux_diagnosis 完成，无阻断；核实原锁、坏令牌拒绝、临时文件类型限制与启动失败释放。产品和局部清理补丁已应用，决定见[笔记](../../../.agents/notes/implemented/bug-fix/2026-10-24-personal-token-atomic-publish.md)。受控首次/轮换红绿、坏旧令牌、临时文件类型拒绝、写入/发布故障释放锁与残留 tmp 均已完成。Linux Node22.19/24.15 的真实入口与 CLI 各 38/38 通过；真实 bin 经认证就绪后注入测试体失败，仍按顺序停止后台、关闭模型监听、删除目录，无遗留。独立多清理故障探针确认所有释放均执行；`node:test` 在测试体失败时会隐藏 after 的聚合异常，现补 stderr 同时报告三类清理失败，仍抛 AggregateError，两个反例均自然退出 1。源码与原始日志见[令牌证据](../evidence/test-reduction-2026-10-24/fixtures/token/)、[清理独立审查](../evidence/test-reduction-2026-10-24/fixtures/token/cleanup-independent-review/review.md)及 [Linux 完整记录](../evidence/test-reduction-2026-10-24/linux-diagnosis.md)。最终固定工作区全量已通过，Node24 双平台验收按主工单继续。

产品体验验收不适用：恢复已承诺的本机管理入口，未增加主观交互取舍。工程平台与真实清理证据不可省略。

## 当前验收状态

独立实现审查与相关平台定向检查通过；最终 macOS `8025120` 的完整 `npm run check` 1125.163 秒自然退出 0，零失败或取消，包含本修复与回归。下一责任为拥有者授权后，由实施者随主工单完成同一提交的Node24 双平台环境验收；拥有者已授权本次提交，尚未推送。
