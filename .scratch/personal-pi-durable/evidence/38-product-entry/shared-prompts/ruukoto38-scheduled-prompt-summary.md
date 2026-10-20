# 38 定时与 main 模型提示修订补充验收

原三文件旧工具退役补丁已完成 35/35 测试、ESLint、tsc 与独立审查；其证据仍以 `/tmp/ruukoto38-tool-retirement-summary.md` 及对应源码清单为准。本轮在该候选之上同步主代理修订的 `packages/agent/src/driver.ts`、`session-factory.ts`，只向 115 的定时根请求增加消息正文和系统提示均不得指导 `notification_enqueue|service_manage` 的断言。`inputText(req)` 不包含 system，因此两处断言均保留；最终回报分支仍先返回，原 success/retry/cancel 闭环断言不变。

## 实际模型输入与宿主估算

使用真实 Runtime/SQLite、SDK 装配、持久选择记录与 prompt 产物，模型端为本地确定性 HTTP 桩。分别取普通 main 与独立 scheduled 两种真实身份的首次请求，读取完整 SDK prompt 快照、适配后完整 HTTP 请求、同次 `SelectionRecord.estimates`。没有按字符数自行换算 token。改前两份使用原版 driver 与 session-factory，改后两份使用主树修订版两文件，源码 SHA 在快照与摘要中记录。

| 身份 | systemPrompt 改前 | systemPrompt 改后 | toolSchemas 改前 | toolSchemas 改后 |
| --- | --- | --- | --- | --- |
| scheduled | 2088 | 1790 | 10737 | 10737 |
| main | 1862 | 1613 | 11265 | 11265 |

两种身份的改前实际 system 均指导了不存在于本次 tools 的 notification_enqueue 与 service_manage；改后两者都不再出现，固定目标的一次最终回报说明和平台格式说明仍保留。每种身份的完整 SDK tools 与 HTTP tools 在改前后逐项相等；main 有 30 个工具、scheduled 有 29 个工具，差别是 main 的 browser，分别记录其本身份估算。工具估算没有变化。

实际快照：`/tmp/ruukoto38-scheduled-prompt-before.json`、`-after.json`（scheduled）；`-before-main.json`、`-after-main.json`（main）。每份包含完整 system、工具定义、SDK 发送前产物、适配后请求、真实会话身份与宿主选择记录。

## 失败与最终检查

最初只同步 driver 删除追加提示时，115 新增 system 负断言让 3 条定时用例全部失败，独立实发探针也拒绝通过；定位到继承的 `SYSTEM_PROMPTS.main` 仍指导已退役工具。该中间版本失败证据保留为 `/tmp/ruukoto38-scheduled-prompt-driver-only-failure.log` 与 `-driver-only-tests-failure.log` 及对应返回码，不能记为通过。

主代理同时移除 session-factory main 里的旧通知动作和整条旧服务工具指导后，`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='定时工作流 (success|retry|cancel)：' test/115-workflow-final-delivery.test.ts` 为 3/3 通过、0 跳过、退出码 0，耗时 2615.531375 ms。两身份改后探针都退出 0。改后的 driver、session-factory 与 115 的定向 ESLint 退出 0。没有重跑已过的 35 条整组，没有运行 native101、全仓 check、外部模型或真实 IM。

临时探针另发生过两个验证脚本错误：最初临时目录前缀过长导致 Unix socket 路径 EINVAL；普通 main 任务误等 scheduled 风格的 resultSummary 导致超时。分别缩短前缀、改为等待持久 completed 状态后成功，失败日志按 socket-path/probe/summary-null-failure 名保留。两项均未改产品代码，不计作产品通过证据。

## 交付与范围

增量补丁 `/tmp/ruukoto38-scheduled-prompt-assertions.patch` 只修改 115，接在已应用的 `/tmp/ruukoto38-tool-retirement.patch` 后。SHA-256 为 `7da5870b8b67cc259a88d02fe27a22590ef3b5c706f819b2ccb5268d2f954e0a`。本轮完整源码清单 `/tmp/ruukoto38-scheduled-prompt-source-after.json` 共 4037 项，相比初始候选只变动原三测试与这两份共享提示源码。三个最终相关文件的精确 hash、各身份数字与返回码在 `/tmp/ruukoto38-scheduled-prompt-summary.json`。主树由主代理独占，本任务未写主树。

本证据局限于共享旧库 main/scheduled 模型提示与对应定时闭环，不解除36、39或生产阻断。共享 driver/session-factory 的最终提示变动晚于原 pack 快照，因此不能继续宣称最终共享源码与原 pack 源码完全相同；原独立安装/解包运行结果仍对应它自己的源码基点，后续差异由本轮源/请求快照及主代理安排的相关 Code/worker 窄复核承接。

独立终审：`/root/implementation_review` 已核对最终主树源码 hash、增量 patch、两身份完整实际快照与工具前后相等，结论无阻断；记录为 `/tmp/ruukoto38-shared-prompt-final-review.json`。
