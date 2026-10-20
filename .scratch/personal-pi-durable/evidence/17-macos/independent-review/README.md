# 独立实现审查

审查者 `inspection_audit` 直接读取规格、工单 16/17、实际源码、调用方、测试和相关决定；仅写本目录，未修改共享源码或用例。当前实现无未解决阻断；适用源码见 [SHA-256 与结论](review-summary.json)。实施者后续的实质修改需复核受影响部分。

## 检查

最终亲跑 `npx tsx --test test/personal-services.test.ts test/personal-service-operations.test.ts test/personal-cli.test.ts`，104/104 通过，零失败、取消或跳过，原始输出见 [最终三文件](final-three-files.log)。其后仅将索引一致性比较移到无 root 的提前返回之前，独立复核受影响的初次工具调用及旧版本拒绝两项通过，见 [增量日志](index-order-followup.log)，不增加唯一用例数。较早的 [83 项基线](baseline-three-files.log)与 [19 项新增用例](new-cases.log)是施工中的中间快照，不与最终集合累加。另亲跑 `npm run verify-notes`、`npm run check:docs` 与 `git diff --check` 通过；报告续审后的最终重验保存了 [notes 日志](notes-final.log)与 [docs 日志](docs-final.log)，diff 检查输出留于审查会话。

## 报告等待与暂停恢复续审

blocker 返回类型的扩展使报告 watcher 与暂停恢复的原结论失效；本次重新读取全部值消费者，复核旧 string 服务分支、新 inspection/admission 分支、实际 document 观察、deepEqual 竞态复核及按不可变接纳核实历史暂停来源。此范围现无未解决阻断，当前源码与新增用例已纳入 [内容快照](review-summary.json)。

亲跑 `npx tsx --test --test-name-pattern='委托报告' test/personal-service-operations.test.ts`，旧服务及新检查两个窗口各 3 项、合计 6/6 通过，见 [窄面日志](report-blocker-followup.log)；其中旧 3 项与既有 104 项重叠。另完整执行 `test/personal-reports.test.ts`，28/28 通过，见 [报告回归](report-regression-followup.log)。均为零失败、取消与跳过。

[报告 watcher 负例脚本](report-watcher-negative.mjs)在临时副本只把 inspection 分支恢复为观察 ServiceOperationDoc，新增 before-admission 与 before-http 两窗口都得到 faulted 而不是 completed，连同父项共 3 项按预期失败，见 [原始反证](report-watcher-negative.log.gz)及 [脚本结论](report-watcher-negative-driver.log)。[变体源码](report-watcher-negative.ts)是当次实际执行内容；临时副本已清理，依赖仅以符号链接只读复用。该证据证明新增用例能捕获错文档观察，不代替真实平台验收。

## 精确窗口

[接纳后、spawn 前强杀](admission-before-spawn.mjs)使用实际 SQLite、mock HTTP 与真实 Node 子进程：底层接纳 commit 已提交而 runner 尚未收到提交返回时 SIGKILL；此前没有 helper spawn，恢复首先停止原 ID，随后只用新 ID 观察，原 ID 的迟到启动被拒绝，未决占用归零。见 [原始日志](admission-before-spawn.log)。helper 是协议替身，本探针不证明真实 systemd。

[迟到 I1 停止证明](inspection-cas-audit.mjs)将实际 stop-inspect 子进程挡在文件门处，应答前把记录换为 I2；原模块保留 I2 占用并只保存旧证据，见 [通过日志](inspection-cas-audit.log)。它使用内存 Harness 替身，CAS 与 SQLite 的组合另由仓库精确用例覆盖。[隔离负例模块](inspection-cas-negative.mts)仅撤去停止结果提交处的 sameAttempt 比较，同一 [负例入口](inspection-cas-negative.mjs)按预期失败：I2.stopped 被改成 true，见 [反证日志](inspection-cas-negative.log)。重跑负例的预期退出码为 1。

[预排队审批探针](queued-restart-and-snapshot.mjs)先让服务操作等待审批，再由另一输入在同目标留下未核实检查，最后批准原操作。修复前真实观察为 pending=1、restarts=1，见 [原失败日志](queued-restart-before-fix.log)；当时源码未另存完整快照。消费事务补占用复核后，同一探针为 pending=1、restarts=0，见 [修复后日志](queued-restart-fixed.log)，仓库新增用例也纳入最终 104 项。

## 模型输入

[实际请求](requests.actual.json)保存本次 mock HTTP 接收的完整请求体，包含完整 [工具列表](toolSchemas.actual.json)、[系统提示](systemPrompt.actual.txt)及后续模型请求中的停止未核实工具结果；没有截取单个工具代替完整输入。主会话实际收到新的退出核实、占用及结束本轮指引；子会话仍为空工具，本片无其装配变更。

按紧凑 JSON 字符数除以 4 向上取整估算：实际新 toolSchemas 为 3012 字符、753 token；实际 systemPrompt 为 213 字符、54 token。[旧工具列表](toolSchemas.before-source-reconstruction.json)以 `git show a8fd60c:apps/ruukoto/src/personal-services.ts` 的旧 service_inspect 描述替换当前实测列表中的对应描述，其余 schema 与工具经 diff 核对未改，得到 2957 字符、740 token；系统提示源码未改，按同样重建为 213 字符、54 token。没有旧版实际 HTTP 快照，旧值明确属于源码重建。详细来源和捕获时哈希见 [快照摘要](model-snapshot-summary.json)。

## 未覆盖

未执行真实模型、真实 IM、真实 systemd 或正式 sudoers；未独立重跑 Linux 与 CI 精确矩阵，实施者另持其证据。不把命令桩、同组检查或本片工程结果扩大为通用命令/MCP 停止证明、断电保证、产品体验或完整 A1–A12 验收。

原始反证日志以 gzip 无损保存，避免原始输出的尾随空白触发提交门禁；解压字节与原记录一致，重跑脚本仍生成 `.log`。
