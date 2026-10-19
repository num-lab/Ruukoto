# A1 失败账本（39 承接原 36/38 未归因项）

Status: open；A1 未通过，本账本不关闭任何门槛。

本账本由 2026-10-19 独立上下文只读审计产出；证据路径均相对仓库根下的 `.scratch/personal-pi-durable/evidence/`，只在需要时补 handoff 或源码路径。审计实际读取了工单、交接、JSON 清单、gz 日志（解压后核对）与当前源码哈希；没有运行测试或业务、没有重跑历史宽批次、没有修改源码/测试/既有证据、没有 git add/commit/push、没有接触凭据、真实 IM 或生产。下面凡写“已验证”只指本次实际读到的文件、哈希、计数或日志文本；“未核实”表示本账本没有独立证据。

## 总判定

A1 不能记通过：原 17 macOS 身份查询、原 17 Linux local 停止、原 38 native101 三项从未取得首故障字段（失败 PID、libproc/ps 返回、errno、完整 stopped 回执与 exit/stdout 时序），其余 8 项只有当前正常路径或邻接修复的绿测；没有任何一项得到“原失败原因已归因”的证据。新绿、批量扫描修复、停止尾帧修复都只能证明其当场范围，不能反写历史；本账本保留全部旧失败事实，不把它们改写成“已修复”或“环境问题”。

当前候选证据存在一次明确的快照漂移：`39-final-acceptance/candidate-current-source.json`（SHA256 `59c4bcac4716b860185df732b96fb3c6f5ada0b383572f31e72016d62b3d0c34`，649 项）只对 2026-10-18T15:55Z 的 v3 快照成立；本次逐文件核对当前工作区只有 643/649 匹配，6 份差异为 `apps/ruukoto/src/personal-harness.ts`、`personal-service-operations.ts`、`personal-service-work.ts`、`personal-work-tools.ts`、`personal-work.ts` 与 `test/personal-service-operations.test.ts`，与 `handoff-2026-10-19/source-delta.json` 记录的 6 项差异一致。`handoff-2026-10-19/source-manifest.json`（SHA256 `b2fa5776314c602ac89ab719d454e912a2e7edccd5edb582cac1e77f3998752d`，649 项）本次对当前工作区逐字节核对 649/649 匹配，应作为“当前源码”的绑定，而不是 59c4 的 v3 清单；`39-final-acceptance/macos/final-v3-artifacts.json` 与 `linux/final-v3-artifacts.json` 绑定的是 59c4（sourceMatched=649，capturedAt 2026-10-18T15:56Z），`handoff-2026-10-19/macos-artifacts.json` 绑定 b2fa57 且 buildExit=0，但 handoff 目录没有对应的 Linux 制品重绑。任何“当前候选 649/649、两平台制品已绑定当前源码”的表述只能按 v3 快照引用，发布候选必须重新冻结。

因此本账本的复用口径是：A1 的历史失败继续按原始证据保留；当前叶证据只按“已核对的源码/测试/worker/锁哈希 + 明确 delta”引用；不给 A1 通过结论，不关闭 39 的 A1 门槛，也不代替负责 Agent 修改 39/36/38 正文或工单状态。

## 状态汇总

| 项 | 当前状态 | 当前可用的最强证据（本次已核实） | 复用不可越界 |
| --- | --- | --- | --- |
| 原 17 macOS 身份查询 | 未归因；首故障字段缺失 | 36 的基点/当前/修复版 122 各 1/1、433/433、39/39、5/5；17 原失败 `failure.json` 与空统一日志查询 | 不得称已修；不得用 101 身份查询或停止尾帧竞态代替原因；不重放 `write_result_missing` |
| 原 17 Linux local 停止 | 未归因；邻接竞态已修但不能追认 | `17-linux/extra122.log` 原 `change_2` stopVerified=false 与 busy；36 尾帧修复先红后绿、Linux 122 1/1、158+1 平台跳过 | 尾帧修复只解释“可产生同形态”，不是原触发证明；不得把新 122 绿当原 17 原因 |
| 原 38 native101 identity_unavailable | 未归因；未稳定复现 | `38-product-entry/check-exclusive-failure.log`、`native101-diagnostic/summary.json`（基点/当前窄例各 3/3 绿、native 五文件与二进制逐字节相同） | 不得与 17 同因；不得称 38 修好或全仓检查已通过；共享环境/组合时序仍未排除 |
| 112 script_cpu_limit/预算与超时 | 仅正常路径；原因未归因 | 112 整文件 14/14（同测试字节 412791…）；86 批次两产品同路径绿；18 项/38 项补充 | 不解释原 `script_cpu_limit` 与 7 个等待超时；86 非最终单快照全绿；不重跑历史现场 |
| 118 事件数 63≠61 | 未归因；仅正常路径 | 118 整文件 10/10（同测试字节 0f2098…），原断言仍在并通过 | 不称事件协议已修；63≠61 原因未得，不抹除旧断言 |
| 125/22/45/83 | 仅正常路径 | 四组归档日志 5/5、17/17、7/7、24/24；测试当前哈希与记录一致 | 逐文件绿不代表原宽批次组合复现；原等待/abort 超时未归因 |
| SubAgent snapshot/role 超时 | 扫描机制已修；原组合超时未归因；首轮红日志有缺口 | 86/86（含两文件）、18/18、原 15 秒双进程 2 红→final-v2 2 绿、19 份作者日志哈希全对 | 修复只解释批量扫描成本形态；不解释原 38 具体块；39 首轮 snapshot 红日志未归档；role 未在首轮计划内跑到 |
| 32-dev 宽批次停滞 | 仅正常路径；停滞/中断未归因 | `38-product-entry/dev-final.log` 25/25；75 日志含开发项；32 无本轮行为 delta | 25/25 不解释逾 13 分钟停滞；不推出当前缺陷 |
| personal-tools 60 秒 | 仅正常路径；原 60 秒未归因 | 75 日志中同一用例 19.1 秒通过；787 广组无 personal-tools 失败 | 不称 60 秒原因已查明；75/787 只是正常路径 |
| personal-command-work 中断 | 部分修复；原文件级 INT 未归因 | 787 的仅两失败已证实为旧 offset/totalChars 精确对象断言（日志显示新增字段）；命令/夹具 40/40；报告登记三态先红后绿 | 不解释原 432 秒文件级 INT；不把 787 追改为全绿 |
| 122/supervisor 历史边界 | 历史首故障未归因；当前正常/停止链绿 | 36 三版 122 各 1/1、39/39、5/5、433/433；Linux 122 1/1；18 项含 122 六输入；a1-first-fault 真实原沙箱 122 1/1 且全 stopVerified | 当前绿不是历史原因；首故障诊断只是实验仪器；再见真实失败须先取首故障字段 |

## 逐项账本

### 1. 原 17 macOS 六输入 verify_3 身份查询失败

原始失败事实：2026-10-17 16:18–16:23 JST 的六输入工作流 `verify_3` 由原生监督器 90761/worker 90762 执行，`identity_unavailable` 使该步 stopVerified=false；工作流以 `write_result_missing` 暂停并保留占用，`attempts=11`、`usedMs=114955`，后续整项回报超时。上述字段见 `17-macos/coding-diagnostic/failure.json`（SHA256 `1ee705211f7d13fb97a96f5d010e410c8b5ab6afcabdc05e3629cb0b7bb96b68`）与 `36-coding-regression/README.md`；原统一日志查询（`36-coding-regression/macos/original-system-log-query.json` 与原输出）exit 0、匹配事件为零，不能补回首故障。`17-macos` 原现场与 `36-coding-regression` 的 macOS 证据只支持“该失败类别存在、迁移前后的监督器源码字节相同”；`36-coding-regression/macos/a8fd60c-regression.log` 与 `3053bf6-regression.log` 证明的是停止尾帧竞态在基点和当前原版均红，不能反向推出这次 identity 失败就是该竞态。`native-identity-eperm.log` 是迁移前另一次同类 `count=0/EPERM` 记录，不能证明原 17 同因。

当前状态与复用边界：未归因，且缺少首个失败调用位置、实际查询 PID、返回长度/errno 与运行或停止阶段；结论只能写“历史原因未知，安全暂停与占用规则保留”。不可用后来 122 或 101 窄绿解释它，不可用固定 PID 重查或无限重复绿测关闭它，不可重放旧 `write_result_missing` 工作；若未来真实再现，须先用带首故障字段的诊断构建记录，再决定检查。

### 2. 原 17 Linux change_2 完全访问 local 进程组停止未核实

原始失败事实：同一轮 Linux 原失败的 `change_2` 是 local 进程组 3165125 的 `stopVerified=false`（不是 native user scope），随后工作流暂停并出现 `busy`；`17-linux/extra122.log`（SHA256 `8c17e934d3031f116c73449e4b270d9f19b579a82e11733bbbfea32b35c0f462`）保留原始记录，`17-linux` 的 journal 窄查询未补回触发原因。36 确认并修复了一项迁移前既有竞态：Node exit 先于 stdout 完整尾帧时宿主可能过早缓存 false；修复为仅 local 完全访问、worker 组已停且缺回执时另等最多 3 秒，六例新增、修复前红/修复后绿、独立探针四例齐备，`36-coding-regression/macos/final-100.log` 39/39、Linux 最终 122 1/1（约 144.4 秒）；但 36 自己声明该反例不证明原 Linux 就是这个时序。

当前状态与复用边界：未归因；`stopVerified=false` 的 worker 组查询、命令组查询、完整 stopped 回执与 exit/EOF 顺序缺失，不能从“已修竞态”倒推原触发。复用上可写“停止安全边界与相邻竞态已由 36 覆盖”，不能写“原 Linux 失败已修”；新 122 绿只作当前正常路径，不解释原失败。

### 3. 原 38 native101 控制通道关闭回收已累计后代 identity_unavailable

原始失败事实：38 的全仓检查首串行批次 44 项中 1 项失败：`test/101-native-macos-helper.test.ts` 的“macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代”返回 `started pid=92332` 后 `stopped reaped=false reason=identity_unavailable`，来源见 `38-product-entry/check-exclusive-failure.log`（SHA256 `f09e807e7cd3e4e90baf30a42d406b7693526f794242882d3c13ec71382e1d07`）；该命令未运行剩余批次，`38-product-entry/native101-diagnostic/summary.json` 明确 `remainingBatchesWereNotRunByThatCommand=true`、`fullCheckStillFailed=true`。窄诊断在基点和当前原版各 3/3 通过（`native101-diagnostic/current-1..3.log`、`baseline-1..3.log`），测试与四份 native 源以及独立编译二进制的 SHA256 两端相同（二进制均为 `43441a966e3b6fb3111e57f68077dbee76b008f198e1addb3bcac690d7f85729`），且结束无残留夹具进程；报告同时保留“观察到非本轮归属的长时间测试进程”这一共享环境限制，未把其推定为失败原因。

当前状态与复用边界：未归因（未稳定重现；不能确定精确触发或排除组合时序/共享环境影响），且与 17 的 macOS 身份失败独立，不能合并成“一次尾帧竞态”或“同一根因”。复用上只能写“已登记 38 未改动既有 native 路径的验证缺口”，不可写“38 已修/全仓已通过”；也不能拿后来 101-helper 44/44 绿替代原失败解释。

### 4. 112 的 script_cpu_limit 与预算/超时

原始失败事实：38 宽批次中 112 有 8 个 block：个人首项为显式 AssertionError，`reason=script_cpu_limit`，`change=completed`、`validate=running`，时长约 27694ms；另 7 项为等待工作流/验证/冻结/汇总的超时。该原文在 `38-product-entry/app-rest-failure-analysis/failure-groups.json`（`source_log` SHA256 `7d0ecd5b373694f7875d7fdf16be88d023f135926a5b8b47e1acb06a4c0d6e63`，与 `commit-raw-evidence.tar.gz` 内 `app-rest-partial.log` 原始成员一致；展示副本 `app-rest-partial.log` 的 SHA256 为 `973911c25ceb7e6fdd827868b8184ea6e16110055293201d2fdd8f2411e5656a`）与 `workflow-diagnostic/README.md` 的采样热点记录中。采样只说明失败瞬间执行了 `identityCovers` 同步保护目录扫描，不量化新目录带来的耗时增量，也不解释其余超时。

当前状态与复用边界：当前 112 整文件 14/14、exit 0（`macos/coding-audit-112.log.gz`，解压 SHA256 `32f28197f0c13e8efc708f2675caeb8d35d0087391c85eaddcc04f2546ea800d`），测试字节当前仍为 `412791264755d467f2914c5ad5c28a8367be3a6b3a9d4d4235e20d5e570957cf`；`native-protection/author-ruukoto39-native-batch-regression.log.gz` 中两产品 112 的真实 Driver 用例也绿。该叶环境（`macos/coding-audit-environment.json`）记录 11 项源/worker 哈希，其中 `approved-ops.ts` 为 `819f2bfa…`，与当前 `3a14e1a8…` 不同；`native.ts` 未在该记录内。故 112 的 14/14 只作“当前测试/锁/三份 worker 与当时一致的正常路径”证据，不能写“script_cpu_limit 已修”或“112 预算问题已解决”，也不能把 86 批次称作最终快照全绿（86 运行期间还有末端 stat 守卫变化）。

### 5. 118 的事件数 63≠61

原始失败事实：38 宽批次中 Code 重复回答断言失败，原文为“核实原回答不重复推进或发事件”，`actual=63 / expected=61`，位置 `test/118-workflow-entries.test.ts`，见 `38-product-entry/app-rest-failure-analysis/failure-groups.json` 与 `commit-raw-evidence.tar.gz` 的原始日志成员。当前同文件断言仍在（现行测试第 194 行仍断言 `getMaxSeq()` 前后不变），118 整文件 10/10、exit 0（`macos/coding-audit-118.log.gz`，解压 SHA256 `38fedac003b81e9867a26ce042261404395ee8c0de428fed383c89a269269a03`），测试字节与审计环境记录均为 `0f20981f8c8f57144b496efac15fd42344e3c16fcb84d9497d55f4b1f40e15d5`；之后 native 保护扫描改动不改变事件协议，个人报告/来源文案也不等于 Coding 入口变化。

当前状态与复用边界：未归因，仅正常路径。10/10 只能证明当前代码在该断言下通过；63≠61 的历史原因（重复推进来源、事件写入路径）仍未得到，不得写成“事件协议已修”或“118 已归因”。旧测试/旧宽批次记录继续保留，不应因新绿删除或改写。

### 6. 125/22/45/83 四组

原始失败事实：38 宽批次中 125 有 2 个等待超时、22 有 3 个等待超时、45 有 5 个 Abort TimeoutError、83 有 1 个“等待目标临时单元产生”超时且无 reaped/identity 事实，均见 `38-product-entry/app-rest-failure-analysis/README.md` 与 `failure-groups.json`（43 blocks、25 wait_timeout、5 abort、3 test timeout、6 assertion、2 TypeError、2 file-level，分类互不叠加）。39 本轮逐文件首轮结果为 125 5/5、22 17/17、45 7/7、83 24/24、exit 0，日志已归档为 `macos/coding-audit-{125,22,45,83}.log.gz`；`macos/coding-group-archive-manifest.json` 记录 5 个成员，四份 gz 的 stored SHA256 分别为 `98a48811…`、`43d7d15f…`、`00b0e820…`、`2faa3690…`，解压后分别为 `03d71a30…`、`1c6dfe81…`、`ca48b77f…`、`a69492bc…`，与 `coding-audit-groups-summary.json` 的 testBefore/After 和 logSha256 一致；当前测试文件哈希仍分别为 `19f6d72b…`、`decc5fd…`、`18b5a51f…`、`ff078ef4…`，与记录一致。

当前状态与复用边界：四组只有当前“逐文件正常路径”证据，原宽批次中的等待/abort 原因未归因；日志中 `head=b1e975…` 但工作区是未提交的 v3 源码，运行只绑定了各测试文件哈希与命令，没有整树清单绑定该次运行。复用时可写“对应测试当前字节下逐文件 exit 0”，不可写“宽批次组合已通过”，也不应为此重跑历史宽批次；45 的 5 个 Abort 不能并入 83 或 native 回收失败。

### 7. SubAgent snapshot 与 workflow-role 超时

原始失败事实：38 部分补跑（`app-rest-partial.log` 展示副本；原始字节在 `commit-raw-evidence.tar.gz`）末尾保留 `subagent-workspace-snapshot.test.ts` 的“受保护角色的结构化文件工具与宿主批准入口都不能写来源或私有基线”等待超时 49372ms（`等待超时: 保护任务终态`），以及 `workflow-role-integration.test.ts` 的“ruukoto 的普通与工作流 reviewer…”等待超时 107718ms（`等待超时: 普通审查完成`）；`failure-groups.json` 计为 snapshot 3 个 block、role 1 个 block。39 首轮逐文件计划在 snapshot 处停止：`coding-audit-groups-summary.json` 的 `stoppedAtFailure=true`，snapshot 整文件 exit 1、约 74.7 秒，`plannedCases` 中 role 未执行；该失败日志本身只以 SHA256 `d90fa880…` 记录，没有归档进本目录，`coding-group-archive-manifest.json` 也只含四份通过日志与 groups-summary。当前机制证据是原生保护树批量核对修复：`author-ruukoto39-native-batch-regression.log.gz` 86/86（命令含 snapshot 与 role 两文件，日志中两产品 reviewer 用例均通过）、`author-ruukoto39-native-batch-final-targeted.log.gz` 18/18（含两产品 reviewer 与“受保护角色”用例）、原 15 秒双进程反例 `baseline-load-1/2.log.gz` 2/2 exit 1（`等待超时: reviewer 终态`，约 20.2 秒）→ `final-v2-load-1/2` 2/2 exit 0（约 9 秒）；作者 19 份日志的 gz 解压哈希本次全部与 `author-delivery.json` 记录一致。

当前状态与复用边界：扫描机制已修（有红绿和边界负例），但原 38 组合超时的根因未归因；39 首轮 snapshot 红日志存在证据缺口（只有摘要+哈希，没有可引用的失败用例正文），role 在首轮序列里没有实际跑到，不能写成“首轮 role 已绿”。86 批次运行中仍在补充 stat 守卫，不能称“最终单快照 86 全绿”。复用上可写“当前目标范围由 86/18/15 秒红绿接续”，不可写“原 snapshot/role 超时已解释”，也不得把 15 秒反例当作原 38 块的同一场景（前者测试名与失败断言不同，只是同类形态）。

### 8. 32-dev 宽批次停滞/中断

原始失败事实：38 宽批次中 `test/32-dev.test.ts` 文件级失败，时长 820528.914791ms（约 13.7 分钟）；随后主代理在逾 13 分钟后单独 SIGINT 该自有文件（`38-product-entry/app-rest-test32-interrupt.json`，pid 86030），记录明确“no TCP or app child found”，日志无业务断言，只有文件级 `test failed`。当前证据：`38-product-entry/dev-final.log` 主树单独 25/25、无跳过；`macos/original-personal-failures.log.gz` 75/75 覆盖开发与个人原失败文件；32 实现与开发入口本轮无行为 delta。

当前状态与复用边界：仅正常路径；原宽批次停滞/中断原因未归因，不能从单文件 25/25 推出宽批次根因，也不能据此判当前缺陷。复用只能写“32 测试当前单文件通过”，不可把 75/25 当作组合停滞的解释，也不应为历史现场重跑宽批次。

### 9. personal-tools 60 秒超时

原始失败事实：38 宽批次中 `test/personal-tools.test.ts` 的“durable 通用工具：主子会话沿目录权限读写，二进制产物分页与请求输入可重建”60722.339583ms 超时（`test timed out after 60000ms`），该文件随后在自有 INT 记录内，见 `failure-groups.json` 与 `app-rest-interrupt.json`。当前证据：`macos/original-personal-failures.log.gz` 75/75 中同一用例以约 19.1 秒通过，787 广组其余运行也无 personal-tools 失败；来源/分页/报告/媒体另有窄叶覆盖。

当前状态与复用边界：仅正常路径；原 60 秒超时原因未归因，不能称已修或“预算已够”。复用可写“同一用例当前在 75 秒组内通过”，不可写“personal-tools 历史失败已解释”；787 的重跑也不是原文件的完整替代。

### 10. personal-command-work 文件级中断

原始失败事实：38 宽批次中 `test/personal-command-work.test.ts` 文件级 `test failed`，432488.428ms，该文件在自有 INT 记录内，见 `failure-groups.json` 与 `app-rest-interrupt.json`。当前证据：787 广组记录 `macos/owner-boundary-personal-regressions.log.gz` 为 787 项、784 pass、2 fail、1 skipped；本次核对日志确认两 fail 是“durable 命令：auto-review/full_access 报告记录 command 暂停…”的旧精确对象断言，diff 显示实际结果新增 `offset`/`totalChars` 字段（日志第 902–939 行），与 39 记录“两处既有 offset/totalChars 旧期望”一致；修正后命令/夹具 40/40（`report-registration-root.log.gz`），running/unknown/restored 三条报告登记先红后绿另有作者 126 项与独立 3 条。

当前状态与复用边界：部分修复（旧断言已按实际结果更新、报告登记语义已修），但原文件级 432 秒中断与宽批次中断本身未归因；不得把 787 追改为一次全绿，也不得把 40/40 说成原 INT 的原因。原失败事实、INT 上下文和旧 787 计数继续保留。

### 11. 122/supervisor 历史边界

原始失败事实：原 17 macOS `verify_3` 的 122 身份查询失败（见第 1 项）、原 17 Linux `change_2` local 进程组停止未核实（见第 2 项）、原 38 native101 身份失败（见第 3 项）是三份互相独立的现场；另 38 宽批次中 `test/122-workflow-code-acceptance.test.ts` 有 1 个“等待六输入整项回报超时”block，明确“不能记为原 native 回收失败”。当前证据：36 的 macOS 基点原版/当前原版/修复版 122 各 1/1（约 82/84/84 秒，`36-coding-regression/macos/{base,current,final}-122.log`）、停止 39/39（`final-100.log`）、macOS helper 5/5、26 文件 433/433（`final-regression.log`）；Linux 最终 122 1/1 约 144.4 秒、八文件 158 通过+1 平台跳过（`36-coding-regression/linux/final-122-evidence/test.log`、`final-minimal-evidence/test.log`）；39 侧 `native-protection/author-ruukoto39-native-batch-final-targeted.log.gz` 18/18 含 122 六输入用例；`native-protection/a1-first-fault-evidence.tar.gz` 记录真实原沙箱 122 一次 1/1、exit 0、105.7 秒、全部 stopVerified、无停止失败诊断，首轮 Linux 诊断因共享依赖 overlay 不可见而失败的前提错误原样保留；`native-protection/native-identity-invariants-result.json` 的 mock C 不变量探针 exit 0，只证明调用方安全边界。

当前状态与复用边界：历史首故障仍未归因（缺 PID/返回值/errno/完整回执时序），当前只证明正常/停止链在所列范围通过。复用可写“122 当前正常与停止链有 36 与 Linux 窄叶、18 项和真实原沙箱 122 支持”，不可写“原 17/native101 原因已得”或“supervisor 历史边界已关闭”；首故障诊断 patch 只作实验仪器，不建议合入产品；未来真实再现时应先取首故障字段再归因，不能无限绿跑等待自发重现，也不重放旧 `write_result_missing`。

## 已修机制（只能解释相邻形态，不构成历史归因）

停止尾帧竞态：36 在“local 完全访问、worker 组已停、命令组回执缺失”时增加最多 3 秒有界等待；`late-frame-before.log.gz` 5 项中 1 项红、`late-frame-after.log` 5/5，完整 100 文件 39/39；`old-host-source.json` 证明 `498fc62`/`a8fd60c`/`3053bf6` 三版 `host.ts` 字节相同（`05cb6bad…`），`a8fd60c-regression.log` 与 `3053bf6-regression.log` 均在基点/当前原版复现同一断言失败。该机制能产生原 Linux 的失败形态，但没有原现场时序，不能归因为原 17 Linux 的原因，也不解释 macOS identity 失败。

原生保护树批量核对：`approved-ops.ts` 改为每次每个保护根一次批量核对，保留逐根代码资产只读例外、身份/祖先关系与子文件 bind/硬链接拒绝，不保留跨调用缓存；13 份作者日志/8 份双进程日志的哈希与 `author-delivery.json` 全部一致，边界负例 8 项、根只读负例 8 项、原 15 秒双进程 2 红→final-v2 2 绿、86/86 与 18/18；这解释“重复同步遍历导致超时”的形态，但不解释原 38 各 block 的具体触发，也不能把 86 称作最终同快照全绿。

## 本次实际核对的证据与数字

四组归档：`macos/coding-group-archive-manifest.json` 的 5 个成员均存在；groups-summary 实际 SHA256 `efc40fc08ba5c334a1aa7764a25798386bd1d87bb939fdc4ca749facdae63a29` 与清单一致；四份 gz 的 stored 与解压哈希全部匹配（见第 6 项），测试计数 5/5、17/17、7/7、24/24 逐份确认；`/tmp` 下原日志已不在，归档解压值与 `coding-audit-groups-summary.json` 的 logSha256 相同，属计划内归档。

112/118：`macos/coding-audit-summary.json` 的 14/14（约 153.7 秒）与 10/10（约 11.4 秒）与归档 gz 解压日志一致，解压 SHA256 分别为 `32f28197…`、`38fedac0…`；当前 `test/112-workflow-real-steps.test.ts`=`41279126…`、`test/118-workflow-entries.test.ts`=`0f20981f…`、`package-lock.json`=`446035b1…`、三份 worker=`ec4d1232…`/`2e6719fd…`/`43441a96…` 均与被审环境一致；唯一被记录但已变化的源是 `approved-ops.ts`（审计时 `819f2bfa…`→当前 `3a14e1a8…`），当前值与作者最终交付 `author-delivery.json` 的 `3a14e1a8…` 相同。

原生批：`author-delivery.json` 的 11 份日志与 4 组双进程 8 份日志 gz 解压后哈希 19/19 与记录一致；86 日志 86/86，18 日志 18/18，86 命令包含 112 两产品 Driver、snapshot、role 等 10 个文件，日志中两产品 reviewer/受保护角色与 112 Driver 用例均可检索到；`stoppedAtFailure=true` 的首轮 groups-summary 与 39 首轮叙述一致。

其他 A1 相关日志：`macos/macos-exclusive.log.gz` 44/44（含 100 与 101-helper 用例）、`macos/original-personal-failures.log.gz` 75/75、`macos/report-registration-root.log.gz` 40/40、`macos/owner-boundary-personal-regressions.log.gz` 787（784/2/1，两失败为旧 offset/totalChars 断言）、`macos/integrated-native.log.gz` 38/38、`macos/macos-node22-entry.log.gz` 49/49、`linux/final-native24.log.gz` 45（44 过/1 mac 专用跳过）、`linux/final-native22.log.gz` 45（44/1）、`linux/oracle-node24-tests.log.gz` 94（93/1）、`linux/oracle-node22-tests.log.gz` 108（107 过/1 模型流等待失败，保留）、`linux/oracle-native-retry.log.gz` 54 过、`linux/native-file-bind.json` 与 `native-protection/dir-clock-linux.json`（32 样本中 29 个目录时间未变，只说明时间戳粗粒度）均在。

36：`base-122`/`current-122`/`final-122` 各 1/1、`final-100` 39/39、`final-macos-helper` 5/5、`final-regression` 433/433、`late-frame-before` 5 中 4 过 1 红、`late-frame-after` 5/5、`old-host-source.json` 三版 `host.ts` 相同（`05cb6bad…`），以及 `17-macos/coding-diagnostic/failure.json`=`1ee70521…`、`17-linux/extra122.log`=`8c17e934…`、`38-product-entry/check-exclusive-failure.log`=`f09e807e…` 均存在且与清单固定值一致；`39-final-acceptance/native-protection/stop-unattributed-manifest.json` 对上述文件的固定哈希与本次实测全部一致，其指向的 `/tmp` 探针文件已不在，但 repo 内 `stop-unattributed-analysis.md`/`native-identity-invariants.c/.log/.json` 与清单 SHA 一致。

38：`app-rest-failure-analysis/failure-groups.json` 的 `source_log_sha256`=`7d0ecd5b…` 与 `commit-raw-evidence.tar.gz` 内 `app-rest-partial.log` 原始成员解压哈希一致；展示副本 `app-rest-partial.log` 为 `973911c2…`（README 已声明是规范化展示副本）；runner 计数 2542/2480/40/3/19、约 1306 秒与 README 一致，43 block 的 25/5/3/6/2/2 分类本次逐项复核一致；`native101-diagnostic` 的 current/baseline 日志各 3/3、原生二进制两端同为 `43441a96…`；`app-rest-interrupt.json` 的 plannedTargets=5/actualSignalsSent=3 与 32 单独 INT 记录均符合 README 更正后的口径。

候选与制品：`candidate-current-source.json` 649 项、`changedFilesFromInitial=50`；本次实测 643/649（6 份差异见总判定）；`handoff-2026-10-19/source-manifest.json` 649/649 与当前工作区逐字节一致（b2fa57）；`macos/final-v3-artifacts.json` 与 `linux/final-v3-artifacts.json` 均记录 sourceManifestSha256=59c4、sourceMatched=649、capturedAt 2026-10-18T15:56Z；`handoff-2026-10-19/macos-artifacts.json` 记录 b2fa57 且 buildExit=0；handoff 目录没有对应当前源码的 Linux 制品。

## 不一致与证据缺口（审计发现）

1. v3 候选清单与两平台 v3 制品已不是当前源码：当前 6 份差异（`personal-harness.ts`、`personal-service-operations.ts`、`personal-service-work.ts`、`personal-work-tools.ts`、`personal-work.ts`、`test/personal-service-operations.test.ts`）。`a1-closure-plan.md` 第 5 行称“649 份中本次实读匹配 649 份”、`final-a1-v3-readonly.md` 第 9 行称“649 项全部匹配，差异 0”、`final-matrix-review-v3.md` 第 9 行称“当前 649 份清单逐字节匹配”，都只对 2026-10-18T15:55–15:56Z 的 v3 快照成立；`39-final-acceptance/README.md` 第 116 行“当前源码清单…固定 649 个文件”的“当前”也已被 handoff 的 6 项晚改动替代，虽然同文件第 7 行已声明 v3 结论只对 v3 快照有效。引用这四处时必须改成“v3 快照”，不得当作发布候选当前绑定。

2. 39 首轮逐文件计划的 snapshot 红日志没有归档：`coding-audit-groups-summary.json` 只保留 exit 1、74.7 秒与 `logSha256=d90fa880…`，`macos/` 下没有该日志的 gz 或明文，`coding-group-archive-manifest.json` 也不含它。因此“39 首轮仍红已保留”目前只有摘要与哈希，不能在最终账本引用其失败用例名/断言正文；如需引用，必须补原始日志，否则只能写“摘要记录 exit 1”。

3. 四份逐文件 result JSON 未归档：`a1-closure-plan.json` 的 `fourTemporaryGroups` 记录 `/tmp/ruukoto39-coding-audit-{125,22,45,83}-result.json` 与其 SHA256，但 repo 内没有这四份文件（最小五文件归档说明将这些列为“备选”）。最小归档集只有 groups-summary+4 日志，已核实；result JSON 只能引用哈希。

4. `handoff-2026-10-19/source-delta.json` 的“current”值只对 11:27Z 前状态成立：其 `personal-work.ts`=`98ac0e00…`、`test/personal-service-operations.test.ts`=`0560c854…` 与本次实测当前值 `a076508a…`、`2e928bf2…` 不同（后来 11:55/12:03 又有改动），不能把 source-delta 当作当前源码清单；当前绑定用 source-manifest.json b2fa57。

5. 原 15 秒双进程反例与 38 原始 snapshot block 不是同一场景：反例测试为 `subagent-workspace-snapshot.test.ts` 的“ruukoto-code 完全访问父级派发 reviewer…”，失败断言是“等待超时: reviewer 终态”（约 20.2 秒）；38 原 block 是“受保护角色的结构化文件工具…”的“保护任务终态”超时（49372ms）与 role 的“普通审查完成”超时（107718ms）。反例可证明扫描成本形态，不能当作原 block 的现场复现。

6. 38 的 `/tmp/ruukoto38-app-rest.log` 已不存在：`failure-groups.json` 的 source_log 指向 /tmp，但原始字节已按 38 的提交格式收进 `commit-raw-evidence.tar.gz`（成员 raw SHA256=`7d0ecd5b…`），展示副本是 `app-rest-partial.log`（`973911c2…`）。复用必须引用归档成员或说明展示副本，不能把展示副本冒充原字节。

7. 112/118 叶环境只绑定 11 项源/worker：`coding-audit-environment.json` 未包含整树 649 清单，也记录 `approved-ops.ts=819f2bfa…`（已被当前 `3a14e1a8…` 替换）、未记录 `native.ts`；因此“测试/核心 runtime 与事件链未变”的论断由这些哈希加 delta 推理支持，不是同一整树快照的重新运行，引用时必须同时给出 18/86 的差异覆盖。

8. 86 批次不是最终单快照：`author-delivery.json` 的 `regressionContentTiming` 明确 86 运行期间在 125 之前/期间补充批量初始 stat 守卫，最终 worker 后的 18 项覆盖新边界；86/18 不是一次同一快照的两次计数，不能相加；`stoppedAtFailure=true` 的首轮序列中 role 文件未执行，不能写成“首轮 role 已绿”。

9. 39 README 第 110 行“三个 Coding 生成 worker 与原 112/118 环境和 v3 制品逐字节一致”本次核实成立：三份 worker 当前值与 112/118 审计环境、v3 制品及 handoff 当前 macOS 制品记录一致（`ec4d1232…`、`2e6719fd…`、`43441a96…`）；但该句不能反推“整树当前绑定”，整树仍受第 1 条与第 10 条约束。

10. handoff 目录的当前源码制品只有 macOS：`handoff-2026-10-19/macos-artifacts.json` 绑定 b2fa57 且 buildExit=0，但没有 Linux 侧对应 b2fa57 的制品清单；v3 的 Linux 制品绑定 59c4，因此“两平台制品已绑定当前源码”目前不成立，发布前必须补 Linux 重构建与两平台制品清单。

## 发布候选残余风险处置

以下属于发布候选可接受、但必须在发布声明与 39 正文中明确披露的限制，且不得写成“已修”：原 17 macOS 身份查询、原 17 Linux local 停止、原 38 native101 identity_unavailable 的精确触发仍未知，产品侧仅保留既有安全暂停、占用与人工核实规则；112 的 `script_cpu_limit`/7 个等待、118 的 63≠61、125/22/45/83 的宽批次等待/abort、32-dev 的逾 13 分钟停滞、personal-tools 的 60 秒超时、personal-command-work 的 432 秒文件级中断、38 的 snapshot/role 组合超时，均按历史失败保留，当前叶证据只覆盖正常路径或邻接修复。把这些作为“有限历史风险”接受的前提是：不声称原失败已修复、不删改旧事实、不把窄绿拼成全绿。

以下必须保留为待验、不得由本账本或当前绿叶关闭：A1 门槛本身及 39「唯一工程待办」A1 两行的关闭决定（只能由负责 Agent 在最终验收正文中明确处置）；最终发布 commit、锁依赖、两平台实际制品与 worker 指纹的重新冻结（v3 59c4 已过时，b2fa57 当前只有 macOS 制品）；39 正文中“原因未归因持续阻断”的旧口径与当前结论的收束（36/38 正文仍写有该旧口径，本次未改）；若最终账本要引用 39 首轮 snapshot 的具体失败用例，先补归档原始日志；112/118 叶与最终 `approved-ops.ts` 不同字节这一差异，必须以 18/86/边界负例的覆盖为前提写清，不能省略；未来真实再现停止失败时，必须先用带首故障字段的诊断构建取首故障（PID、调用点、返回长度、errno、阶段、回执时序）再归因，禁止用重复绿测或扩展预算关闭；原 17 两个运行的 `write_result_missing` 工作不重放，旧工作流也不宣称可由重启/恢复队列完成。

## 本账本未覆盖与使用限制

本账本只审计 A1（原 36/38）相关材料，不覆盖 A2–A12、真实 QQ/TG/NapCat/模型、37 报告正文、a12 演练与 40 生产接管；不检查全部 649 项源码，也不复核 39 handoff 中服务事实、QQ 控制、NapCat 维护等非 A1 结论。审计没有运行任何测试，因此本账本中的通过计数全部来自既有日志或清单解压核对，不是本次新跑结果；任何需要“当前真实运行”的结论仍应由负责 Agent 按最终候选范围单独取证。本账本可被 39 最终验收正文引用为“A1 历史失败与复用边界”，但其结论是 A1 仍未通过、门槛不关闭、历史原因未知，不得被改写为 A1 通过或历史失败已解释。

## 拥有者处置（2026-10-19 晚）

按披露性残余风险收口。本账本“A1 未通过、门槛不关闭”的结论作为处置前的审计事实保留；收口不等于归因或修复，后续不得据此声称历史失败已解释。处置决定与候选记录见[工单 39](../../../issues/39-final-acceptance.md)与[release-candidate.md](../release-candidate.md)。
