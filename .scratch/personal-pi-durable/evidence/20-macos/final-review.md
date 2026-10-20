# 工单 20 独立实现审查

审查者：`service_recovery_review`。结论：列明的 17 个最终实施文件无未解决阻断；本审查不表示完整迁移或正式切换已验收。主工作区只读，隔离实验与报告均写于 `/tmp/ruukoto-20-independent-2ex4jqto`。

## 对象与依据

基点为 `9a27e87899a4c0f31ee89fc065dbf5b27bc18b3d`，有效要求亲读总规格、总工单、工单 19/20、服务操作/Telegram 权限/固定检查控制/子检查及相关恢复决定。直接核对原服务 API、stop-op 退出证明、Telegram 收件事务及原已送达菜单选择、Harness 扩展装配与恢复。已按开发流程、错误处理、文案、人类文档及检查范围规范审查。

最终内容以 `.scratch/personal-pi-durable/evidence/20-macos/source-manifest.json` 的 17 文件 SHA-256 为准，清单自身 SHA-256 为 `8d3dbd438f576f7f10e073fc83b53d8b8b105467eeea1cb9d1dabfbdd7c371c2`；逐项核对无差异，不以未改变的 HEAD 冒充已审内容。完整机器清单见同目录 `final-review-scope.json`。

## 实现结论

CLI 通过既有本机认证接口查询原操作并保存一次性效果证据；Telegram 仅当前 bot/owner/代次及已送达原宿主菜单有决定资格，转发、摘录、错 bot、旧入口和未送达菜单均拒绝。效果决定、操作引用与控制收件同事务，重投沿原收件，已保存结果不可覆盖；恢复双向核对菜单、原文、效果及控制引用。

停止请求只创建 durable background Task。接纳和执行分别要求已消费、非 started 的未知写操作，拒绝审批前检查；固定原 requestId/TaskId、hostOpId 与机器，调用前复核原入口，结果写回 CAS 核对原身份。仍仅调用原 stop-op，不调用 inspect/restart；错误证明或失败保留原占用，Task 失败可查且不循环重核。人工效果证据不能代替原启动器/命令单元退出证明，也不恢复长期授权。独立扩展在接纳前持久安装，旧程序因缺扩展拒绝恢复。

最终文案区分已知执行结果、started 与未知效果。已知 executed/not_executed 不再显示需要人工停止核实；未知效果才显示双事实门槛。文档、决策与现行代码一致，未改模型工具清单或系统提示，未改依赖、共享包或正式入口。

## 已关闭意见与隔离反证

1. 原效果确认菜单也能接纳停止，而恢复只允许服务详情菜单。实现已增加 `menu.kind === service-recovery` 门禁。隔离副本仅删除该门禁，原新增回归按预期红：实际多出 serviceStop Task；另一个独立探针完成该错误接纳后关闭，确认重开以 `service_control_invalid` 拒绝，证明原问题确实破坏恢复。最终正例拒绝错误菜单并完成后续重开，意见关闭。
2. 旧强杀用例杀 helper 后再取 pending 第一项，取消路径先保存退出证明时列表合法变空。亲读基点诊断 `sigkill-baseline-probe.log`，其中 pending=[]、原 inspection.stopped=true 且已有 stopEvidence；修正只在 kill 前捕获原引用，原占用、独立聊天、唯一 inspect、取消完成与释放断言全部保留。独立副本恢复旧查询后原行 663 按预期红，修正版最终窄集绿，意见关闭。
3. 原历史详情无条件显示写停止未核实，可能把已知结束操作误示为仍占用。最终已区分已知与未知，并覆盖拒绝结果及三模式成功结果，意见关闭。

## 亲自执行

此前已审内容执行下列完整独立窄集；末轮仅首个服务控制用例增加证据同步，其单例另行亲验，未改生产源码或其他 16 文件：

```sh
npx tsx --test --test-name-pattern='服务核实控制|服务工作：默认自动审查|Telegram 服务核实|Telegram 服务停止|服务核实向导|子检查：后台 SIGKILL' test/personal-service-operations.test.ts test/personal-telegram-permissions.test.ts test/personal-cli.test.ts test/personal-services.test.ts
```

19/19 通过，0 失败、0 跳过。覆盖新服务控制、三模式已知结果、Telegram 原菜单/入口/重投/落盘回链、执行前换代零外调、CLI 选择流程与旧强杀用例。早前的服务 4 项、Telegram/CLI 10 项和单例复验已被最终集合覆盖，不叠加计数。

`npm run verify-notes`、`npm run check:docs` 与 `git diff --check` 亲验通过；新增 testing note 后复核 notes，最终源码与文案后复核 docs/diff。两项隔离负例的失败均为期望结果，没有改主工作区。

## 核对作者验证材料

已读取本机 summary、首轮完整 personal+产品入口、最终受影响与最终文案回归日志、静态/构建末轮日志，以及真实 PTY result/requests/observations。首轮 380 项中的既有 SIGKILL 失败保留，修正版受影响四文件 187 项为 186 通过、1 Linux 专用跳过，最终三文件 114 项为 113 通过、同项跳过；可按唯一场景记 379 通过、1 本机跳过，不累加重叠集合。构建日志中的 Coding 包 SHA-1 仍为 `5af04e561c9fbf84bf29f8237e3655e563ea5ed9`。

最终 PTY 使用真实终端，CLI 源码 hash 为 `7d364a1072e1e1b69869774d408dc850e081d72739dcf7d78913baa5a2f2edff`，与最终清单一致；11 次认证 Unix socket 请求、效果及停止 POST 各一次，1378 字符证据分页。替身仍返回停止未核实，向导未将登记称为停止成功。这是材料核对，没有冒称本人驱动 PTY。

## 末轮测试同步增量

Linux 首轮总集合由执行角色报告 380 项全过；后续文案三文件第一次为 113/114，首个新控制用例期待 launcherStopped=false 时原 verify 可能仍在途。原逻辑只等待显式重核 Task 结束便删除失败标记并更换 helper，原可信 stop-op 若稍后完成，可合法提交停止证明。重复 5 个单例及同内容 114 整集通过不能排除该窗口，原失败保留。

最终仅为该用例增加按原 requestId 过滤的两条 stop-op ServiceOperationEvidence 同步，再改变 helper 应答。该阶段只有原 verify 与显式重核两次停止调用；两条证据均在 helper 已返回后的状态提交事务产生，因而确实等原调用和显式调用都提交，关闭在途可信应答窗口；错误机器证明保留占用及全部后续断言未变。亲跑 `npx tsx --test --test-name-pattern='服务核实控制：效果与停止分开保存' test/personal-service-operations.test.ts` 为 1/1 通过。与上一审查快照相比，17 项仅 `test/personal-service-operations.test.ts` 哈希改变，生产源码未变，其他审查及不受影响检查沿用；最新清单逐项核对一致。Linux 修正后的最终报告及日志已核对，结果与边界见下一节。

## Linux 最终证据复核

亲自读取 `20-linux/report.md`、summary、steps、实际测试日志、final-manifest-check、tested-manifest、parent-source-manifest、cleanup-verified、task-processes-before-cleanup、process-comparison 和 artifact-storage。执行环境为 Ubuntu 6.8.0-117-generic x86_64 / Node 24.21.0 / npm 11.19.0；执行由另一独立角色完成，本审查只核对材料，没有亲自在远端运行。

步骤 exit code 与实际日志一致：12 personal 文件 363/363，产品入口 17/17，合计 380 个唯一场景；文案增量首轮 113/114，失败日志保留，同内容复验 114/114；最后仅测试同步增量后 service-operations 整文件 53/53，单例连续 3 次 1/1。没有首轮逐次调用时间线，因此不声称该次 Linux 失败必由发现的并发窗口导致；源码同步明确关闭该窗口，仍保留首轮根因不确定性。实际 Unix socket/生产 useSudo/-n 路由使用的是 sudo 可执行命令桩，不能算真实 sudo 提权、systemd、IM 或模型验收。

最终 1391 文件源清单 SHA-256 `e43834f7422832f6bf8ee4bdd65aaa15a4838200a7f5a9283e59b3ba2ab5c682`，远端校验记录 missing/changed 均为空；17 实施文件与最新作者清单完全一致。审查时再比较当前树，1391 清单只与后来更新的 01/20 交接工单不同，17 实施源仍全部匹配。专属 /tmp 与 tmpfs 根目录均已不存在，专属进程扫描为空、无新增僵尸；7 条既有后台 PID/PPID/状态/命令在 before/after 均相同。

证据归档曾含无关进程命令行凭据；该归档阻断已关闭。仓内四份进程阅览副本已整条脱敏，四份含凭据原件移至仓库外 0700 目录、文件 0600；亲自核对原件解压 SHA-256 与 artifact-storage 记录一致，并递归检查两平台证据（含 gzip 解压内容）没有原敏感记录。未复述凭据值。其余原始失败日志与 PTY 原字节仍以 gzip 保存并已核对原哈希，阅览副本的控制符/行尾变换明示。Linux 证据校验清单已重建，74 项逐项无差异；没有用变换后的阅览副本冒充原字节。

## 未验证项

真实 Telegram、真实模型、生产 helper/systemd、拥有者主观体验、完整 A1–A12 与正式切换不在本片已通过范围。Linux 由独立角色执行，本审查只核对最终材料，未冒称本人在远端执行。没有独立重跑全仓 check，也未提交、推送或部署。

## 完整被审文件

| 文件 | SHA-256 |
| --- | --- |
| `.agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md` | `dbcaee560df61ca6f3ff18181ef950d8eec01c910072b1c0df901ea30c9acbd8` |
| `.agents/notes/implemented/architecture/2026-10-17-personal-service-recovery-controls.md` | `042bd3bad97872f57a5b345aad5f767330f94b6e8b571727cccb01a572cc1daf` |
| `.agents/notes/implemented/testing/2026-10-17-inspection-stop-test-reference.md` | `bdb15a66d0d3b3248f9a65d788228a8c14d4f57d18466c00689daf82d48c00d3` |
| `apps/ruukoto/src/personal-cli.ts` | `7d364a1072e1e1b69869774d408dc850e081d72739dcf7d78913baa5a2f2edff` |
| `apps/ruukoto/src/personal-control.ts` | `f898d5d6b11efe9a9addbfcf404e1adf88cec0295b1ba723c37fba599b604f8e` |
| `apps/ruukoto/src/personal-harness.ts` | `56b42e95992783d4997a76eb1c9c945b5f072dc2911bf17e22b9143c09617b0a` |
| `apps/ruukoto/src/personal-service-controls.ts` | `f4414dd64ce54ab317beebdcfd5f9307b26ce813d2bb64d7f67f3eed5206dae1` |
| `apps/ruukoto/src/personal-service-operations.ts` | `ce3b190d5da49585075fa2e7d0107a9ee2d571f0a29ab24e67c45c833a6fce8f` |
| `apps/ruukoto/src/personal-telegram-records.ts` | `79b8ea3a0984e2518d1d21f23103f8b9d99e1136401a922e9c6cf3f7b0af73a7` |
| `docs/modules/agent-tools.md` | `749549d75665f3e4d20a0f7dd5bd7fa7d811d7de51d33cdfed368038aff09c11` |
| `docs/modules/personal-durable.md` | `dbc55d7345de54c3e502d948e916ca890d013e79e416f1cc73c071884d477a8a` |
| `docs/modules/products.md` | `8b83686cc6bde92f10bae6a22f4f21fe39677a4a2f1d963a3f9d7d16ff4d93c6` |
| `docs/usage.md` | `47856ac7c1978141514f881c6da98eca3f006b32a616e12139044fb24ec71e82` |
| `test/personal-cli.test.ts` | `84ec8bfe037463da5cd1996c24398ae3d9c569a085b3993a716385c5e552b68c` |
| `test/personal-service-operations.test.ts` | `0c5e8f525358db7f1894f0083736f450a12e9205d0d2ee8c0d877f17ab9c2bf6` |
| `test/personal-services.test.ts` | `da6878d70670f96d9d07e1dc3c129acee38e63505ab9ece02af15d34ad7710cc` |
| `test/personal-telegram-permissions.test.ts` | `152fce1e2a0971de6626445773be6a98e4354fa40b3ac92587d06d40b22ab3cc` |
