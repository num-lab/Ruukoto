# Coding 回归调查与当前证据

源码基点为 `a8fd60caceda3bbb243afff167a7c44751e749f4`，当前为 `3053bf6` 加本轮 `host.ts` 与停止回归；实现指纹见 [macOS 环境与构建](macos-environment-build.json)。调查保留[原 17 macOS 诊断](../17-macos/coding-diagnostic/README.md)和[原 Linux 失败](../17-linux/extra122.log)，不改写原失败结论。工单与最终验收状态见 [36](../../issues/36-coding-regression.md)。

[独立终审](independent-review.md)覆盖实现、原始材料与最终传输；[交付指纹](final-sha256.json)绑定本轮改动文件与证据，自身不计入清单。两平台工程材料通过，历史精确归因项继续待验。

## 原失败归因边界

macOS 原失败位于 `verify_3` 的原生监督器：`identity_unavailable` 使停止未核实，工作流以 `write_result_missing` 暂停并保留占用，最终回报等待超时。原日志没有具体失败 PID、libproc 返回字节数或 errno，无法还原精确 OS 触发。基点与当前监督器源码、构建字节相同；迁移前[另一次真实验收](../../../agent-workflow/acceptance-evidence/native-identity-eperm.log)已经捕获同类身份查询 `count=0/EPERM`，而[旧 CI 调查](../../../ci/2026-10-11-previous-ci-failures.md)中的大量短命进程实验未复现另一例。它们证明该失败类别既存，不能证明原 17 同样是 EPERM。

另按原监督器/worker PID 90761/90762、原窗口 2026-10-17 16:18–16:23 JST 查询本机统一日志，命令 exit 0、匹配事件为零，未补回身份查询证据；[查询参数](macos/original-system-log-query.json)与[原输出](macos/original-system-log.txt)保留，不将空日志当作未发生故障。

Linux 原失败位于 `change_2` 的完全访问 **local 进程组**，不是原生 user scope。`stopVerified=false` 传播到同一暂停与占用路径，随后宿主工作遇到 busy。原记录没有组查询结果或停止回执时序，不能将它归因为后续 Linux 持久执行身份改动。

本轮确认一项既有停止竞态：Node 进程 exit 先于 stdout 尾帧时，宿主可能在完整 `stopped.reaped=true` 到达前永久缓存 false。迁移方案确认时的 `498fc62`、原基点和当前原版 host [逐字节相同](old-host-source.json)，该文件此前最后修改在 2026-10-12；[同源反例](stop-race-probe.mjs)在原基点与当前原版均红，日志见 [基点](macos/a8fd60c-regression.log)和[当前原版](macos/3053bf6-regression.log)。它能产生原 Linux 的失败形态，但没有证据证明原 Linux 就是这次时序，亦不解释 macOS 的身份核实失败。

原 17 两个运行均已 `write_result_missing`，现有协议禁止直接 resume。保留旧事实和成果，独立核实停止及实际写入后沿现有人工处置入口处理；重新验收使用新隔离档案，不重放原写操作，不将重启或恢复队列说成旧工作流已能完成。

## 修复与最窄反例

仅 local 完全访问、worker 组停止已核实而尚缺命令组回执时，host 最多另等 3 秒消费完整尾帧。stdout 结束、关闭或读错误只结束等待；缺帧、半帧、失败回执、超时及 worker 组未停仍为 false。launcher 的 exit 语义、已有停止缓存、目录占用与效果未知规则保持。

`test/100-worker-stop.test.ts` 新增六例。[修复前原日志](macos/late-frame-before.log.gz)五例中成功尾帧一例红；[修复后](macos/late-frame-after.log)五例全绿；包含未关闭管道上限的完整文件 [39/39](macos/final-100.log)通过。[独立代码审查](independent-code-review.json)亲跑五例，再用[独立探针](independent-stop-probe.mjs)验证成功、读错误、关闭和三秒上限四例，撤去等待后成功尾帧按预期红。探针第二参数为被检 host 的绝对路径，使用 `node --import tsx` 执行。原失败输出与实施 patch 含有末尾空白，使用 gzip 原字节保存，未删改原内容。

## macOS 同环境对照

两份独立 worktree 各执行 `npm run setup -- --skip-hooks` 和 `npm run build`，环境均为 macOS 27.0.1 arm64、Node 24.15.0、npm 11.12.1。122 逐版单独运行，未重试转绿；各自首次结果如下。

| 内容 | 结果 | 日志 |
| --- | --- | --- |
| 原基点 `a8fd60c` 原版 122 | 1/1，约 82 秒 | [base-122](macos/base-122.log) |
| 当前 `3053bf6` 原版 122 | 1/1，约 84 秒 | [current-122](macos/current-122.log) |
| 当前加本轮修复 122 | 1/1，约 84 秒 | [final-122](macos/final-122.log) |
| 最终停止与真实进程组 | 39/39 | [final-100](macos/final-100.log) |
| 独占 macOS 原生监督器文件 | 5/5 | [final-macos-helper](macos/final-macos-helper.log) |
| 26 个受影响文件 | 433/433，无跳过，约 435 秒 | [final-regression](macos/final-regression.log) |
| 静态检查 | exit 0 | [static](macos/static.log) |

精确场景命令为 `RUN_MODEL_CHECK=0 npx tsx --test test/122-workflow-code-acceptance.test.ts`。原生 helper 与停止文件分别运行，未将两者故意制造的失父进程夹具并行。本轮额外共享调用方结果单独保存，不把三版相同场景累加成三个覆盖项。

扩展命令为 `RUN_MODEL_CHECK=0 npx tsx --test --test-concurrency=1 test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/08-approvals.test.ts test/11-history-read.test.ts test/23-web-search.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/28-main-data.test.ts test/62-tool-availability.test.ts test/71-product-entry.test.ts test/81-subagent-reuse-close.test.ts test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/92-subagent-lifecycle.test.ts test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/native-linux-identity.test.ts test/browser-lifecycle.test.ts test/browser-tools.test.ts test/web-search-transport.test.ts test/mcp-transport.test.ts test/work-copy-host-runtime.test.ts test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/109-workflow-cold-recovery.test.ts test/111-workflow-capabilities.test.ts`。覆盖当前入口、生命周期、SubAgent/worktree、工作流、文件审批及后续共享 MCP/搜索/浏览器/AppData 默认消费者；Linux 平台分支的可控测试不记真实 Linux OS 通过。合计 478 个唯一通过用例，不是全仓检查或 Node 双版本矩阵。

安装及构建日志保存在 `macos/{base,current}-{setup,build}.log`。[构建与解析探针](scope-probe.mjs)使用 `node --experimental-import-meta-resolve scope-probe.mjs <基点绝对目录> <当前绝对目录>`，核对 Coding 0.85.1、个人 pi-ai/durable 1.3.0 分别解析；两版 Coding 包、worker、工作流脚本、监督器、锁文件和 core 数据库源码逐字节相同，结果见[解析与哈希](dependency-resolution.json)。

## Linux 同环境对照

环境为原 17 同一 tx / Linux 6.8.0-117、Node 24.21.0、npm 11.19.0、UID 1003。两版独立安装/构建，首 ENOSPC 轮执行结果与过程证据不可用，不计通过或失败；修复空间前提后的有效结果另存，没有覆盖原材料。完整命令、缓存差异、空间护栏、最后在途快照及清理事实由 [Linux 交接](linux/README.md)持有。

| 内容 | 结果 | 日志 |
| --- | --- | --- |
| 基点原版首个有效受控空间 122 | 1/1，145.5 秒，exit 0 | [baseline](linux/baseline-controlled-space-evidence/test.log) |
| 当前原版首个有效 122 | 1/1，147.3 秒，exit 0 | [current](linux/current-first-evidence/test.log) |
| 当前修复版 122 | 1/1，144.4 秒，exit 0 | [final-122](linux/final-122-evidence/test.log) |
| 修复版八文件最小组 | 158 通过、1 个 macOS 身份专用用例跳过，exit 0 | [final-minimal](linux/final-minimal-evidence/test.log) |

八文件覆盖停止、原生准备/scope、持久身份、产品入口及 MCP；跳过项已在 macOS 集合执行。最终候选共 159 项通过、1 项平台跳过，不重复累加基点/当前原版的相同场景。[840 项末轮源码](linux/final-evidence/post-source-verification.json)相符，[root 只读扫描](linux/final-evidence/post-test-processes.json)零残留；仅删除两版测试依赖，保留源码/worker/失败档案与日志。123 份远端材料逐项匹配，交付文件另由 [SHA 清单](linux/delivery-sha256.json)绑定。

122 包含启动账户 local 修改/Git 与固定 confirm/native 的独立验证，不能扩称为新增 namespace/网络隔离或持久 scope 跨重启专项验收。原 Linux PID/时间窗口的 [journal 查询](linux/original-17-journal-evidence/commands.json)未补回触发原因；最后在途快照不作为终态完成证明。

## 旧 Coding 档案

[格式探针](data-format-probe.mts)复制到两版同一相对路径后，先由基点运行 `seed <独有绝对档案目录>`，再由当前版运行 `check <同一目录>`，均使用 `RUN_MODEL_CHECK=0 npx tsx .scratch/personal-pi-durable/evidence/36-coding-regression/data-format-probe.mts ...`。基点真实 Runtime/SDK 建立 schema 45 的已完成 Coding 会话和 prompt 产物；没有伪造较早 schema 版本，也没有读取日常档案。

当前启动后硬断言 147 个 sqlite_master 对象、schema_version、旧 task 行、JSONL 完整字节和产物字节保持，启动零模型重放。再在原会话提交一次新任务，模型替身必须读到旧回答，且旧历史保持前缀；请求数恰为一次。结果见 [seed](macos/format-seed.log)、[check](macos/format-check.log)和[指纹](format-result.json)。探针初版相对 import 多退一级，在启动 Runtime 前失败，原日志保留在 [first-import-error](macos/format-seed-first-import-error.log)；修正路径后才建立档案。

## 未完成项

原 17 精确底层触发仍未捕获，A1 和 36 不因当前通过自动关闭；下一实施者负责在可复现现场记录监督器首个失败分支、返回值/errno，或原进程组查询与完整回执时序，再按原验收复核。macOS 历史统一日志与 Linux 窄 journal 查询均未补回原触发证据。本轮没有真实模型、真实 IM、Node 22 矩阵、全仓 check、正式制品切换或生产操作；纯停止内部修复没有新增主观操作体验。
