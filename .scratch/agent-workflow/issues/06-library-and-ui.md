# 工作流定义库与交互入口

Status: resolved

## 目标与边界

落实[规格 A2、A6、A8、A9、A10](../spec.md)，依[实施计划第七节](../implementation-plan.md#七定义与交互入口)开放命名保存、带参运行和工作流控制。不建设流程编辑器或插件分发系统。

## 实施与交付

1. 在实例 agentDir 的 workflows 下管理定义，保存/加载固定内容版本，已引用版本与历史保留；路径、符号链接、大小和语法错误明确拒绝。
2. 为模型装配有明确编写说明的发起/查询/保存/取消工具，身份由宿主注入；模型不能修改运行授权或提高预算。
3. 接入 CLI/TUI 的定义列表与详情、运行列表与步骤状态、阶段日志、人工答复、暂停/恢复/取消；可读错误提供安全下一步，不泄露凭据。
4. IM 提供身份核实后的明确控制命令，绑定运行和问题；来源不符、定位歧义、引用正文与伪造命令不改变运行。
5. 覆盖模型自主启动与用户显式启动、参数化复用、定义更新不改变原运行，以及多个运行与普通聊天并存。

落点包括 agent 宿主工具族、runtime 定义加载与控制、control、packages/tui/src/cli.ts 与 tui、channels IM 入口。共享工具按包 exports 接线，产品差异留在各 app 能力声明。

## 验收与交接

依赖 [05](05-owner-input-and-delivery.md)。新入口有定向用例；回归 `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/33-config-tui.test.ts`、`test/66-control-seam.test.ts` 与 `npm run check:static`。

命令与故障处理同步 README、docs/usage.md、docs/development.md、pre-push-checks 及对应模块文档；更新架构模块地图和 CONTEXT.md 中已确认的领域术语。定义库、模型工具与 CLI/TUI/IM 命令均已接线；本单完成工程验收，真实模型/IM、跨平台联合验证及主观产品体验由 07 持有。

## 当前交接

2026-10-13 由实施者接手，代码基点 `42b7eb6bdbde1040b26beeda48abe9bdde96dc19`，工作区干净。05 已 resolved，规格与完整计划已由拥有者确认；本单涉及身份、文件持久化和跨模块接口，走重流程。独立只读上下文亲读需求与当前源码，方案核实无阻断，无待拥有者重新决定的取舍。

实施补充：命名文件用同一 QuickJS async 函数包装只编译校验，不试运行；读取/保存先拒绝非法名称、路径、符号链接、UTF-8、大小与语法。当前文件与不可变定义版本分开，已接受启动键先查原运行，不重读更新后的文件；保存使用期望摘要与稳定键，版本引用和回执进入 core。显式启动由宿主登记短期发起任务，固定会话当前模型与模式，不从 wire 回填授权；模型发起沿活动任务核实，两路合流到同一协调器。

共享工具只开放编写说明、保存、发起、查询与取消；查询/取消限来源会话，计划模式和步骤不能发起，模型不能调整预算或恢复授权。控制面开放定义列表/详情/历史、带参启动、运行列表/详情/阶段日志、答复与版本化控制；CLI `workflow` 与 TUI `/workflow` 复用已有请求/文本窗口。JSON 从原文解析，写入应答丢失保留原键并先查询，不自动重发。

IM 命令先核实原始发送文本与拥有者入口，按完整运行 ID 定位；启动/控制意图、终态入站事件和回执在同一事务提交，之后停止执行。列表、详情与控制复核原目标及配置代次；业务答复仍不消费工具审批。定义更新、空闲会话显式启动、双产品模型工具、跨会话/跨入口拒绝、多个等待运行与日常聊天、TUI 重连及阶段展示补最窄用例；工程完成后独立实现审查，真实模型/IM 和主观体验按既有分工交 07。

## 工程验收记录

验收对象是基点 `42b7eb6bdbde1040b26beeda48abe9bdde96dc19` 上本单工作区改动；环境为 macOS arm64、Node 24.15.0。命名文件/历史与稳定键、共享模型工具、显式宿主发起、control/CLI/TUI/IM 入口、对应文档均已完成；没有新增依赖。最终 `npm run check:static` 通过，工程验收完成，可交 07。

| 要求 | 实现与证据 |
| --- | --- |
| A2、A6：双产品与两路启动 | `test/118-workflow-entries.test.ts` 用双产品实际 Runtime/Driver 和模型替身核实自主与空闲会话显式启动；直接拥有者 main 可发起，无来源内部 main、计划模式、步骤嵌套及伪造授权拒绝 |
| A8：资源与控制 | `test/118-workflow-entries.test.ts` 核实模型不能提高预算、模型查询/取消限来源会话；`test/119-workflow-im-controls.test.ts`、`test/120-workflow-cli.test.ts` 核实版本化暂停/恢复/取消及拥有者预算；既有协调器/真实步骤回归保留共享名额与停止闸门 |
| A9：命名复用与版本 | `test/117-workflow-library.test.ts` 核实历史字节、期望摘要、原键回执、文件更新不覆盖旧版本、路径/链接/UTF-8/大小/编译失败；118 用真实控制面核实独立历史分页与固定运行，120 用实际 CLI 进程读后页 |
| A10：等待、查询与普通聊天 | 118/119/120 核实多个等待运行、日常聊天、阶段/步骤/问题及答复；`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts` 核实事件分开显示、重连与旧补发、持久原文/原键、滚动窗口和退出不取消运行 |
| 可信控制与失败 | 119 用 QQ/Telegram 实际适配器和本地平台替身核实原入口、旧代次、跨入口/异参拒绝；启动/控制/回执同事务，提交前回滚不报已提交，原外部键可重投。模型失效及限额内深嵌套编译拒绝后偏移推进、聊天继续 |
| 有界查询 | 118/120 与 `test/65-slash-commands.test.ts` 核实历史每页 100 项独立续读；运行列表/详情仅含送达摘要，完整最终事实/回报经 logs 分页，正文与历史偏移互不混用 |

已执行的检查：

```sh
npm run build:script
npm run check:static
npx tsx --test --test-concurrency=4 test/117-workflow-library.test.ts test/118-workflow-entries.test.ts test/119-workflow-im-controls.test.ts test/120-workflow-cli.test.ts test/13-tui-state.test.ts test/14-tui-app.test.ts test/15-tui-pty.test.ts test/33-config-tui.test.ts test/29-cli-entry.test.ts test/62-tool-availability.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts
npx tsx --test test/117-workflow-library.test.ts test/118-workflow-entries.test.ts test/119-workflow-im-controls.test.ts test/120-workflow-cli.test.ts test/65-slash-commands.test.ts
npx tsx --test --test-concurrency=4 test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/94-task-ending.test.ts test/104-workflow-script.test.ts test/100-worker-stop.test.ts test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts test/114-workflow-owner-input.test.ts test/115-workflow-final-delivery.test.ts test/116-workflow-notification-recovery.test.ts test/77-im-approvals.test.ts test/84-im-final-delivery.test.ts test/88-parent-delivery.test.ts test/89-im-entries.test.ts test/93-im-approval-lifecycle.test.ts test/37-scheduler-outbox.test.ts test/51-generic-scheduler.test.ts
npx tsx --test test/100-worker-stop.test.ts
npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts
git diff --check
```

构建通过；首轮入口/界面集合 141/141，后续编译、分页与事务修正后的受影响入口集合 34/34。较广回归 367 项中 336 项直接通过；其余 31 项的 worker-stop 文件首轮有 2 个旧夹具失败，修正后全文件 31/31，所有结果均无跳过。静态首轮 lint/typecheck/notes 通过，文档预算触红后压缩重复导航，`check:docs` 全通过；最终 `npm run check:static` 全部通过。笔记锚点无悬空，差异检查通过。

worker-stop 的两处失败已在独立干净基点原样复现 0/2：`cd7b833` 已把 starting 占位原地更新为实际执行身份，夹具仍预期旧双记录。只更新 `test/100-worker-stop.test.ts` 的记录数量与注册时 UUID 快照，保留失败后禁止重建、停止 false、模式切换拒绝与独立启动身份；无生产代码改变。作者和独立审查者均亲跑该文件 31/31。

## 独立实现审查

不同执行上下文直接读取规格、计划、最终源码、测试与文档，工程审查通过，没有未解决阻断。

- 定义/来源/存储审查亲跑 117/118/119 的 15/15，以及 105/107/108 的 44/44；核实 schema 39、新引用表及双导入策略、原键摘要、异步后活动/取消/权限重检、预算与禁止嵌套。发现的取消后保存、异参误报提交与编译栈异常均由最窄负例复验闭合。
- 交互/控制审查亲跑当前 118/119/120 的 14/14，65/66 关联窄例 6/6；真实请求复现 10000 历史版本与 50 项长报告超帧，修复后历史分页无重复且可读完，列表约 28 KB、正文可经 logs 续读。提交前故障注入证明真实回滚、原外部键重投成功；文档与当前命令一致。
- 既有 worker-stop 夹具修正经独立基点反例与最终全文件 31/31 核实，安全保证没有降低。

## 下一责任人与未验证项

2026-10-13 工程验收与独立实现审查通过，本单 resolved；下一角色接手 [07 联合验收](07-acceptance.md)，按原计划汇总 02–06 后执行完整 `npm run check`、macOS/Linux 与两 Node 版本矩阵、六输入含故意失败项的组合样例、真实模型与绑定 IM，以及拥有者的进度/答复/报告体验。06 的本地替身、PTY 和实际 CLI 进程结果不代表这些外部项目通过；本单不单独判定主观产品验收，因为规格与计划已明确由 07 持有。

新格式为 schema 39/控制协议 22，按既有严格版本策略拒绝旧库与旧客户端；旧资料保留并用匹配代码查阅，不自动回填授权。文件与 SQLite 分别落盘，保存未知结果先按当前摘要与原键核实。本单工程提交按拥有者本轮「提交」指示执行；未推送、部署或发布。
