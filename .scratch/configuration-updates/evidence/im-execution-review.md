# 配置更新 A8/A9 独立实现审查

时间：2026-10-25T11:59:35.456408+00:00。基点：`e84ae1c9c861fa9d49fbfbc0aab7c616ccb37f67`；审查对象为其上的未提交实现，以末尾 SHA-256 为准。需求来源为[规格](../spec.md)和[实施工单](../issues/01-remove-global-restrictions.md)。

## 结论

当前 A8 的平台新接纳、发送句柄与配对，以及 A9 的命令/服务版本迁移和旧恢复，未见未解决的实现阻断。先前发现的四类阻断已用实际反例复现，并在修复后重跑通过：IM 问题/定时输入漏检切换状态、宿主注入旧命令没有历史基线、只读服务文件基线冷启启写、宿主服务撤回转文件丢失运行参数。另补核实旧无版本服务在离线保存、冷启动和原 helper 停止之间的完整恢复。此结论不代表整个工单、真实部署或两壳产品验收通过；Electron 文件异常导航问题已由主代理修复并完成独立GUI10项复验；详见单独GUI证据，MyGo 实机和真实 Keychain 仍待验。

审查为独立执行上下文，直接读取规格、源码、调用方、测试与决定笔记；作者总结仅作导航。本上下文此前编写的模型/MCP/搜索运行时、设置基础层与两处 IM 关闭修复，不以自检计作独立审查；其中共享 records/operations 只对阶段6作者新增的 host 版本与元数据增量给出独立结论，基础事务层由另一上下文审查。

## 要求对应与证据

| 要求 | 核实结果 |
| --- | --- |
| A8 平台边界 | Telegram/QQ 各自串行；核实代次、提交 input 和保存 submissionId 在平台锁内，模型等待在锁外。问题与定时 run/summarize 使用同一 isActive 检查；已有 submission 按原键重连。 |
| A8 原发送 | 普通回复、问题、汇报和定时发送在平台锁内保存 sending 并固定原句柄；网络等待在锁外。QQ 旧连接保留至在途发送结束，新绑定不取得旧待发消息。 |
| A8 配对与故障 | 后台用自己的环境核实候选；proof 绑定原版本并防复用，TG 接管水位 started/observed/confirming 事实保留；未知发送不重发，坏候选不替换原入口。 |
| A9 历史配置 | 命令、后台、服务检查与服务写操作保存原配置选择；缺版本历史只按首个文件基线或一次捕获的 host 基线解释，不取后来候选。host 记录 content=null/revision=missing，保留原文件缺失事实。 |
| A9 迁移资格 | 只等本能力的活动任务、后台、停止与未知效果；在提交时再次核实。旧模型响应版本不符时拒绝新的执行，原执行恢复和停止保持原配置，改回不复活旧计划。 |
| A9 host 旧边界 | 命令以捕获前 entry 边界解释旧无版本记录；服务写操作须在捕获时任务集合内，检查须在 entry 边界前。未捕获旧指纹的离线档案在写意图和文件替换前拒绝。 |
| A9 运行参数与只读 | hostService 保存 useSudo/timeouts；后继服务版本只继承前驱同值元数据，撤回转文件后无需再次注入仍可解码并冷启。初始只读文件/host 基线不启用写能力。 |
| A9 终态/撤回 | 原终态命令不重复停止；服务已核实停止的重复核实幂等返回。首次 null 撤回移除工具，冷启不重建；host 撤回保存新文件版本，旧 missing 事实不改。 |

## 亲自运行

IM 针对性组：22/22 通过，4.0 秒。命令如下。

```sh
npx tsx --test --test-name-pattern='在线换绑|旧凭据缺失|后台配对|配对回执|设置暂停|后台最终报告固定|QQ问题|原菜单逐题|回报认领后丢答|最终发送等待' test/personal-telegram.test.ts test/personal-qq.test.ts test/personal-scheduler.test.ts test/personal-reports.test.ts
```

阶段6已有迁移与恢复组：18/18 通过，266 秒；最后修复后再跑最窄五项：5/5 通过，13.0 秒。两组重叠，不相加为独立用例数。

```sh
npx tsx --test --test-name-pattern='配置切换|服务宿主基线|宿主基线|宿主命令|host.*撤回' test/personal-command-work.test.ts test/personal-services.test.ts test/personal-service-operations.test.ts
npx tsx --test --test-name-pattern='独立审查：只读服务宿主已有文件|独立审查：服务host撤回转文件|服务宿主基线：旧无版本操作|宿主原配置可撤回|离线旧宿主基线未记录' test/personal-command-work.test.ts test/personal-services.test.ts test/personal-service-operations.test.ts
```

反向验证：在隔离副本仅撤去 scheduler 的 isActive 检查，suspended/switching × run/summarize 四子例全部失败，模型请求分别从预期 0/1 增到 2。去掉原命令迁移用例的初始 command.json 后，旧实现冷启真实失败于 parsePersonalCommands(null)；最终 host 版本用例通过。只读服务与 host 撤回的两条短用例均先在未修实现上失败，再于最终主区通过；撤回用例额外断言无 fallback 解码后 useSudo 和 timeouts 与原宿主一致。旧无版本服务完整用例先在未修实现上失败于离线保存未拒绝，最终通过原 helper 路由与双事实停止断言。所有负例只改隔离副本或测试夹具，未修改日常档案。

## Linux 材料核验

亲自通过 ssh tx 读取作者保存的原始日志，并阅读真实后台测试，确认 real=true 分支不替换 BackgroundExecution.launch。初期受控迁移组15/15和真实 Linux scope 后台组1/1均无跳过；最终受控 Linux 组14/14通过，Node24.21.0。真实 scope 只证明后台启动、跨轮保留、原停止、认领释放与重开，不等于生产 sudo/helper 部署通过。

最终源包 `/tmp/ruukoto-stage6-final-linux-source.tar.gz` 的 SHA-256 为 `ff9fe80eddf8c315166045a5b40ac642172396abd88a549c234837fd5aacb225`；日志 `/tmp/ruukoto-stage6-final-linux.log` 的 SHA-256 为 `de504deb726326992e57a17c7647db584cda428338bc4efdceb04f1e2b79c724`。远程原日志为 `tx:/tmp/ruukoto-config-stage6.6ojMkl/stage6-final-linux.log`，初期另有 stage6-controlled-linux.log 与 stage6-real-linux.log。

已逐字节比较最终 Linux 源包与当前主区的 command-work、services、service-operations、service-inspection、harness、settings-records、settings-operations 及三份相关测试，共10文件一致。没有将较早源包或作者自述当作当前最终实现的替代证据。

## 未覆盖与审查归属

拥有者明确暂不做 Telegram/QQ 真实账号外验；受控 API/OneBot 不证明平台实际可用性。生产 helper/root 路径/sudoers、完整日常部署、MyGo 实机和真实 Keychain 不在本次通过项；真实模型证据由主代理持有，本上下文未重复执行。Electron 使用临时目录、测试安全存储及受控 HTTPS 远端，单独记录，不冒充真实 PA 后台或部署。

IM 的无活动同步 close 与 QQ 配对候选 StorageFailed 关闭补丁由本上下文实施；原失败回归已先证实能捕获回归，修后通过，但另一上下文 catalog_credentials 已独立读取最终源码并亲跑原durable/work故障组4/4及QQ候选证据失败组1/1，确认两段通过；此处引用其独立结论，不以作者自检替代。配置运行时与基础事务层也同样不由作者自称独立通过。任何相关源码、规格或笔记发生实质变化，按变化部分复核并更新指纹。

## 文件指纹

| 文件 | SHA-256 |
| --- | --- |
| `apps/ruukoto/src/personal-im-api.ts` | `143d113d05018fa80267bb84679c8537032006b489ab5a442ba4376b8dee908d` |
| `apps/ruukoto/src/personal-telegram.ts` | `f0bd07c3a55dd811ab4d9dde10eccb15678dd08413c9205de251a3eef952a31c` |
| `apps/ruukoto/src/personal-im-pairing.ts` | `2c11f07c80d8191c3cab847b66baa14aaa2d23ed66ae97c19e55a3019f020792` |
| `apps/ruukoto/src/personal-harness.ts` | `0895997becb3f4f015ca7f36dafde37eb58cd7bbe1158fac18df034b111a9dde` |
| `apps/ruukoto/src/personal-questions.ts` | `a72db02a7a4c35155dd02017cf7e2f4e288593d0f3b8aa4e8ef9334d72d95e46` |
| `apps/ruukoto/src/personal-report.ts` | `c872ed0844925fc20f0bed4bb9730cf8b07797121bf0c90f1e0f82f9669805de` |
| `apps/ruukoto/src/personal-schedule-execution.ts` | `3924d43a35aa884ca3cf1b426cac3ea65dd368cb90ded33abb8c2c3fe533bbf9` |
| `apps/ruukoto/src/personal-scheduler.ts` | `dd6d8434d4178c87e854b6c4ac22cdd8f0447e471df204da4596d6e7a802ca55` |
| `apps/ruukoto/src/personal-command-work.ts` | `2e2bde713496553c4f01262237a71c3500ae76b471834304277643542b53ffd0` |
| `apps/ruukoto/src/personal-background-processes.ts` | `9c7756acd921b6ae739f704bc89284b36d654fcf345a2e1adc332dab13b2f4c9` |
| `apps/ruukoto/src/personal-services.ts` | `8eceb24d648e8d536bbaeafe4e7025c97b306e0d821c94a34cd7acc0ad498ebd` |
| `apps/ruukoto/src/personal-service-operations.ts` | `023bd3393c2f2618e997ced0af67f3d136bb225c491953fa6d5a505abc9a9398` |
| `apps/ruukoto/src/personal-service-inspection.ts` | `7fb186cabc3fc82c6e1369ddca42d7884c3a8e60b5916f19c2c3c072b443c4c9` |
| `apps/ruukoto/src/personal-settings-records.ts` | `f559d4a47f39d809218dfdd6d642520f160d903f74b9710163144216eb06e72f` |
| `apps/ruukoto/src/personal-settings-operations.ts` | `88db997d74b2b12644ba397ef520d67feaba16cdee95356ce9bb2999a5993d20` |
| `apps/ruukoto/src/personal-schedule-scope.ts` | `1611187b9efbf07c022f865968a0e08bb4a165bb5ad0f5606643d0adaa5ad2f4` |
| `test/personal-command-work.test.ts` | `ecebbda0e913963ebea3b94fd1efa3944cfb7e62bfbf36884926a2a2d472aad0` |
| `test/personal-services.test.ts` | `f57666322eceaa3fad3a091d5e9ed734f60f365d9e2c66829b2c5a90e9519506` |
| `test/personal-service-operations.test.ts` | `f6d1aebbd83396660f9aaa184059e2afe6c84d8af6a105ab8f5db29846753d8e` |
| `test/personal-telegram.test.ts` | `101c7db9737ef4f5e68463b21b323f7396c2d737f8655c3a50ba592695bca0d7` |
| `test/personal-qq.test.ts` | `29a82237c2890bd081597b44071e5a20c46fe0cafb51b4bc43b7f987038e7224` |
| `test/personal-scheduler.test.ts` | `163e75bf74ccb6edcc73bb27a5d1022f0df75ce58a128c64abf197a77d9cc8a5` |
| `.agents/notes/implemented/architecture/2026-10-25-personal-execution-configuration-versions.md` | `92db5aabbb662214cd5f4ef411331a56ece558b3892cbcc3478b99c599b88f20` |
| `.agents/notes/implemented/architecture/2026-10-25-personal-im-updates.md` | `00c9a14355b47e6bb763541b48da1f7a69df7361c330381ab3659c27a91e9922` |
