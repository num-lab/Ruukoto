# 38 旧模型工具测试退役补充验收

在主树候选源码快照上刷新独立副本 `/tmp/ruukoto38-pack-20261018-1`，复用该副本已经独立安装的依赖与构建制品。基点为 `12b1a66cfa661f2a8bddaa9405283ab9f22cb20c` 加本轮未提交候选；复制后的完整源码清单共 4037 项。主树未写入，未提交。

## 改动

- 113 保留 app_data schema、五个编码工具与实际回执；只删旧 schedule_query 正向装配断言。两个范围用例只删已无装配入口的 notification_query 请求、脚本、断言，以及只服务该路径的 seedNotice 和 imports；新增授权不得扩大范围、真实产物拒绝、跨运行真实产物与历史拒绝、正文不得泄露仍在，标题同步当前覆盖。
- 115 只退役末条通过旧模型 schedule_cancel 取消自身计划的用例及两项无用 imports；共享 scheduler、宿主 scheduleCancel 的取消路径与最终送达闭环保留。
- subagent-source-capabilities 只删普通个人来源 app_data 用例的 schedule_query 正向断言；显式缺工具在登记前拒绝、零模型/零工具意图负例仍保留。

没有恢复、复制或伪造旧模型工具。独立审查者 `/root/implementation_review` 核对实际三文件后报告无阻断。三个文件均只以单个换行结尾。

## 全量工具名扫描

使用 `rg -n '(schedule_(create|query|update|cancel)|notification_(enqueue|query)|service_manage)' test verification/smoke scripts package.json`，并补扫 verification 中非 archive/results 的运行文本。当前 verification 维护入口未发现旧模型工具名调用。完整初次快照命中保存在 `/tmp/ruukoto38-tool-retirement-tool-scan.log`。

40/49/51/85-retire-core-group-chat 的同类旧模型通知/自取消路径由另一独立任务处理，本补丁未触碰这些文件。37/64/79/90/93 的裸 ledger、权限、分类和历史存储值保留；subagent 显式缺 schedule_query 的负例保留；personal-* 中新 durable harness 的 schedule_create/query/cancel 属当前实现合法能力，保留。此前入口字符串审计与本补充工具名审计应合并阅读，不能用旧入口图的检索代替模型工具名检查。

## 实际检查

`RUN_MODEL_CHECK=0 npx tsx --test test/113-workflow-source-capabilities.test.ts test/115-workflow-final-delivery.test.ts test/subagent-source-capabilities.test.ts`：35/35 通过，0 失败，0 跳过，退出码 0，耗时 103250.788333 ms。保留的授权撤销、跨运行隔离、实际 schema 回执、MCP、宿主调度取消与最终回报均在本组真实执行。

`npx eslint test/113-workflow-source-capabilities.test.ts test/115-workflow-final-delivery.test.ts test/subagent-source-capabilities.test.ts --max-warnings=0`：退出码 0。`npx tsc --noEmit`：退出码 0。三文件 `git diff --check`：退出码 0。前后完整源码 hash 对比只改变这三个测试文件。

没有执行 native101、全仓 check、外部模型或 IM 验收；没有把尚在其他任务中运行的检查记为通过。本证据不解除工单36/39/生产阻断。

## 交付

补丁：`/tmp/ruukoto38-tool-retirement.patch`，SHA-256：`414605cafaaee5db8716bc131af4464f7d0bdc3c26030e80fd0ac91eb283149d`。补丁相对复制时主树的三个原文生成；基线原文存于 `/tmp/ruukoto38-tool-retirement-base/test/`。

日志与清单：`/tmp/ruukoto38-tool-retirement-tests.log`、`-eslint.log`、`-typecheck.log` 及对应 `.exit`；`-source-before.json`、`-source-after.json` 是完整源码 hash；`-files.json` 是三个文件与补丁的精确 hash；`-summary.json` 是返回码与结果摘要。
