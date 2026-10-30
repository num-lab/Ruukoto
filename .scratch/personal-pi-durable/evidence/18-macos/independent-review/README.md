# 工单 18 独立实现终审

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../../git-history-cleanup/archive.md)。

结论：无未解决阻断。审查人为独立只读上下文 `child_tool_audit`，基点 `2a10e749710d9e1620358617a0c5a2f311d183de`，macOS / Node 24.15.0。审查过程没有修改共享工作区；运行时探针和反证只在本目录。

## 对象与快照

直接读取总工单与工单 18、总规格、相关既有决定、最终七个 personal 源码、三个受影响测试、四篇人类文档及六篇决策笔记，并对照本地 Pi 1.3.0 scheduler/session/observation 实现。`reviewed-sha256.json` 和同内容的 `reviewed-sha256.txt` 保存 22 个被审文件的 SHA-256；其中总/窄工单仍由根代理补验收事实，后续仅证据/状态更新不扩大运行时结论。`snapshot/` 保存被审源码及测试，依赖通过只读符号链接复用当前安装，未重新安装依赖。

SHA-256 清单自身：14af9240a37571959b6c7a2dc65b0188cbed46e1dff46d986a33f79968d794ca。实施文件（不含继续补证据的工单）另见 implementation-sha256.json，共 20 文件，清单 SHA-256 为 9dc75e25f783fcffbfbbe56b2662c220a6d245e7b87c6038a8344bb76dd5508c。

`reviewed.diff.gz` 无损压缩保存本轮 tracked diff；新文件原文另存于 snapshot。`all-observed-sha256.json` 还保存审查时已出现的工程证据文件指纹，用于辨认材料，不把日志存在等同于通过。`model-before.json` 与 `model-after.json` 是根代理提供的实际 mock HTTP 请求快照；我核对主/子完整工具列表、系统提示及估算，子会话由空工具变为 inspect/read，主会话工具集合不变。这不是远端真实模型验收。

## 亲自执行的检查

| 检查 | 结果 | 输出 |
| --- | --- | --- |
| 隔离 snapshot：`npx tsx --test --test-name-pattern='子检查' test/personal-services.test.ts`，最后新增 SIGKILL 用例前 | 22/22 | baseline-tests.log |
| 隔离 snapshot：`npx tsx --test --test-name-pattern='子检查：后台 SIGKILL' test/personal-services.test.ts` | 1/1 | sigkill-test.log |
| 末轮前提校准后：`npx tsx --test --test-name-pattern='子检查：整项暂停' test/personal-services.test.ts` | 3/3，与前述场景重叠 | final-group-test.log |
| 取消调用方：`npx tsx --test --test-name-pattern='模型工作：取消' test/personal-work-tools.test.ts` | 2/2 | cancel-callers.log |
| Telegram 菜单：`npx tsx --test --test-name-pattern='分析委托：Telegram 原菜单' test/personal-delegations.test.ts` | 1/1 | telegram-wording-test.log |
| 独立探针：`npx tsx --test --test-name-pattern='独立探针' test/probe.test.ts`，在 probes/ 运行 | 3/3 | independent-probes.log |
| 根目录 `npm run verify-notes` | 通过 | verify-notes.log |
| 根目录 `npm run check:docs` | 通过 | check-docs.log |
| 根目录 `git diff --check` | 通过 | 无输出 |

独立探针分别验证：可信宿主 standalone 追加轮检查后可重开；模型取消停止未核实的检查后主聊天继续；子检查未核实阻止整项汇总，重核后继续且 inspect-op 只有一次。探针源码在 probes/test/probe.test.ts，不是产品新增测试。

## 反证

`negative/` 是隔离副本，仅撤去 PersonalWorkTask 三处 `waitForInspections` 调用，保留最终 release 的未核实保护；并在测试副本只选原有正常收尾子场景，增加一条状态诊断，断言保持原样。`negative-source.diff` 和 `negative-mutation.txt` 保存改动。

运行 `npx tsx --test --test-name-pattern='子检查：正常收尾' test/personal-services.test.ts`，退出 1；日志 `negative-wait.log` 显示工作提前进入 `terminal/faulted`，错误为“子工作仍有未核实的检查，占用保留”，`stopVerified=false`，原“任务保持非终态”的断言失败。由于 Pi 不会再次为 terminal Task 调用 abort，这证明等待原停止证明是保持可恢复收尾所必需的；release 保护本身没有被移除，也没有假称它提前释放了身份。

## 已修正发现与末轮增量

首轮发现 standalone work.append 的 note 没有不可改接纳，恢复 cutoff 会排除合法追加输入，导致检查已经完成后仍拒绝开档。作者改为所有新说明写入接纳，并保持历史无接纳资料兼容；我亲见同一独立探针修前失败、修后通过，现有追加/cutoff 回归也通过。

三处旧说明已同步：usage 不再笼统称所有子 Agent 无外部工具，CLI/Telegram 取消说明区分成员固定检查和独立宿主服务写操作。`test/personal-delegations.test.ts` 的断言同步这份菜单事实，没有降低取消、重投零模型和换代断言。`generation.conversationId` 新增与原会话核对。

整项测试恢复后先等工具 Task terminal 再调宿主 recheckStop，是符合 API 拒绝活动工具重核的前提校准；它没有放宽 WorkTask 占用或 OS 停止证明。后台 SIGKILL 用例使用真实 detached fake-helper 进程，证明后台强杀后持久归属、不换检查身份、取消等待原进程退出；它没有证明真实 systemd、生产 helper 的完整组后代或任意命令/MCP。

## 未覆盖

未独立跑全量、Linux、setup/build 或真实模型/IM/systemd；根代理负责汇总这些证据。CLI/IM 仍没有检查重核入口，需要可信宿主 API；停止未核实可持续保留身份占用。子工具只读检查的同组退出保证不能用于任意命令、MCP 或主动脱组后代，完整迁移和正式切换仍未完成。

提交前仅规范部分日志/进程文本的行尾空格及末尾换行，审查 diff 无损压缩为 gzip；上述历史证据指纹保留规范前字节，diff 解压后仍与原指纹一致。20 个实施文件没有变化。
