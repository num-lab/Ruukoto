# 工单 38 最终调用方审计

审计时间：2026-10-18T11:17:50+00:00。审计者：独立只读审计子任务 entry_audit。仓库：`/Users/eitrous/orca/workspaces/ruukoto/migrate-to-pi-durable`，HEAD：`12b1a66cfa661f2a8bddaa9405283ab9f22cb20c`；审计对象是此 HEAD 上的本轮未提交最终改动。本报告只记录调用方迁移与字符串入口检索，不代替整体工程验收或产品验收。

## 结论

发现的两处当前测试调用方遗漏均已在主树修正，最后 diff 已只读核对。在以下检索范围内，未发现仍执行已删除个人装配、旧个人 CLI 协议或已删除冒烟入口的其他当前调用方。此结论依据源码、脚本与调用路径检索；本轮未执行测试，未写主树，仅生成本临时报告。

## 发现与修正

1. `test/99-workspace-boundaries.test.ts:24` 与 `:29` 原来统一要求两个产品的 `npm start/dev -- --nope` 含“参数错误”。新个人入口输出带 `cli_arguments` 的“用法”诊断，因此旧断言会失败。主树新增 `argumentError`，个人匹配 `/cli_arguments/`，Coding 继续匹配 `/参数错误/`；两条入口仍检查退出码 1，原 start 用法断言保留，其他用例未动。已核对最终 diff，修正与产品行为一致。
2. `test/99-verification-entrypoints.test.ts:22` 原来在拒绝 `--remote` 的循环里执行已删除的 `smoke-18-im-final-delivery.mts` 与 `smoke-28-personal-native.mts`。调用方直接以 Node/tsx 启动对应文件，删除后会因模块缺失退出 1，违反预期的前提拒绝退出 2。主树只从数组移除这两项，保留 smoke04、13、15 的退出码、诊断及 PATH 隔离断言，其他用例未动。已核对最后 diff，无进一步修订要求。

拥有者提供的修正前失败日志分别为 `/tmp/ruukoto38-workspace-before.log` 与 `/tmp/ruukoto38-verification-before.log`；本审计未亲自重跑或据此宣称最终测试通过。两文件完整复测由主任务执行，其结果应以主任务日志为准。

## 检索范围与判断

先用 `git diff --name-only --diff-filter=D` 确认本轮删除清单，再以 `rg` 检索完整路径、文件名片段、旧个人 main/bin 路径与动态 product 拼接；检索不局限于 TypeScript import 图。主要范围为 `apps/`、`packages/`、`scripts/`、`test/`、`verification/`、`deploy/`、`.github/` 与根 `package.json`，覆盖 ts、mts、js、mjs、cjs、sh、json、yaml、yml 等执行或配置文本；另扫隐藏 `.scratch/` 的运行脚本，并区分历史脚本、源码快照与 JSON/hash 记录。生成依赖、构建产物及证据目录中的重复快照不作为当前执行入口。

本轮删除的精确目标包括 `apps/ruukoto/src/product.ts`、`scheduler-tools.ts`、`service-tools.ts`、`packages/channels/src/personal-import.ts`、`test/86-personal-instance-import.test.ts`，以及 `verification/smoke/` 下 smoke18、27、28 三个入口。对这些名字的当前执行引用检索，除上述两项已修正测试外，没有发现新的漏迁移调用方；`personal-scheduler-tools.ts` 是仍存在的新个人模块，不能与已删除的 `scheduler-tools.ts` 混为一项。

已人工追踪静态依赖图不直接表达的字符串与动态路径：

- 根 `scripts/start.ts` 按产品进入新个人 main 或 Coding main；根与 app 的个人 bin/dev 指向新入口。
- `packages/control/src/ensure-backend.ts` 与桌面环境的后台 bin 固定为 Coding；当前 Code dev 才调用共享 `runDev`。`packages/tui/src/dev.ts` 虽保留按 profile.product 拼接 bin 的通用逻辑，当前真实产品调用方只传 Coding。
- `test/helpers/backend.ts`、04、10、15、66 的真实子进程走 Coding，Code 控制目录及其他路径绑定测试临时目录；29、73 的动态 product/bin 执行分支为 Coding。32 的真实 dev 进程仅 Coding，保留的旧个人路径属于纯函数分类与环境构造覆盖。
- `test/85-legacy-instance-import.test.ts` 的个人 bin 调用是旧 `legacy-import` 必须被拒绝的负例；`test/personal-entry.test.ts` 的个人 main/bin/dev 调用是新入口正向及隔离、退出、重载覆盖。
- `test/99-workspace-boundaries.test.ts` 的 `ruukoto/product.ts` 字符串只交给 ESLint 作为跨包非法引用负例，不会 import 执行。
- smoke13、15、24、26 的真实 CLI 路径为 Coding；smoke24 的动态 product 源码与 tar 路径也在 Coding 产品约束内。

## 历史脚本与证据边界

`.scratch/agent-browser/probes/runtime-sdk-acceptance.ts`、`.scratch/full-access/verify-current-account.mts` 和 `.scratch/subagent-roles/evidence/04-main-metrics-probe.mts` 仍含已删个人 product 的历史导入。`.scratch/agent-direction/` 下旧 smoke08、18、20、21、22、23 等脚本仍有 pre-workspace 的 `bin/ruukoto.mjs` 或旧个人协议。这些不在当前 npm、CI 或本轮验收入口图里；其中 pre-workspace 路径并非工单38新造成的可复跑入口。

这些历史脚本、源码/hash 快照与过去结果只说明各自原始基点，不能在当前树直接复跑后当作当前验收，也不能据旧结果宣称新个人入口已通过。保留归档正文及历史证据；适用基点和不可直接复跑的说明由当前证据入口承载，需要当前产品证据时应使用本轮维护入口或新增独立验收记录。

## 限制

没有运行 native、重测试、全仓 check 或任何外部模型、IM、生产操作。最终 check 中 101 的 `identity_unavailable` 由另一独立任务归因，本报告不将其归为工单38回归，也不将其记为通过。工单36的原17精确归因缺口及其对39/生产的阻断不在本轮调用方修订中解除。任意运行时构造路径无法单靠文本检索给出形式化穷尽保证；本报告覆盖已发现的静态字符串、脚本分派和产品变量来源。

最终复核文件 SHA-256：

- `test/99-workspace-boundaries.test.ts`：`bbb0a446225ee915e7dbd7e2542e79400c6eefb3b000cdaffc88d2d844fbfdc5`。
- `test/99-verification-entrypoints.test.ts`：`e67347420cc7797e39665fbf624190d11d12827a93d4a5420f110df8220628ae`。
