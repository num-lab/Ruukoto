# Coding 会话后台实施验收

2026-10-21，基点 `01e9e74457a58473b9df1bbdb876cfc9c207747d`，对象为本次实现；最终源码及构建产物SHA见[内容快照](source-final-manifest.json)。有效要求由[工单](../../issues/03-coding-background-processes.md)与[共享规格第3节](../../spec.md#3-后台进程)持有，决定与例外见[会话后台笔记](../../../../.agents/notes/implemented/feature/2026-10-21-coding-background-processes.md)。验收期间没有修改日常档案、迁移旧库、提交、推送或部署；拥有者随后明确授权提交。

## 要求与实现

| 要求 | 验证依据 |
| --- | --- |
| 四工具与真实启动来源；只允许普通拥有者完全访问启动 | `background-processes.test.ts` 的实际SDK工具定义、Plan/受限轮与pending提问断言；[实际模型请求](prompt-after/observation.json)保留原来源，模型只见一个 `process_id` |
| 交接无占用空窗，Task终态不释放后台，未曾agent_wait也可跨轮查停 | `background-processes-core.test.ts` 的事务失败/回滚及禁止DELETE触发器；`background-processes.test.ts` 的真实HTTP、同轮write拒绝、其他会话排队、下一受限拥有者轮与停止后重新写入 |
| 关闭屏障包含已接纳未启动Task，原键只涉及原成员 | core关闭水位用例、Runtime启动/关闭竞争、客户端原键持久化/丢答恢复；[Linux行为反证](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-integration%2Fnegative-close-barrier-behavior.log)撤去水位核实后按预期失败 |
| 每会话一个未核实执行；状态分页、原字节日志及预算有界 | core分页最大转义/完整响应容器临界；日志32 KiB页、base64、文件dev/ino/SHA核实；16 MiB、短写后EIO及篡改拒绝见 `background-processes-recovery.test.ts` |
| 停止接纳与停止核实分开，恢复不重放 | macOS真实身份/继承管道/错代拒绝，Linux真实scope/InvocationID/inode拒绝；实际宿主SIGKILL后冷恢复零重放，缺回执或未知身份保留占用 |
| 后台观测只开状态/日志/停止、提问与合资格browser | 实际请求仅5个工具；不装配普通worker/MCP/目录与委派；浏览器实际调用重核原来源；[独立上层审查](upper-final-review.md) |
| 双客户端选取、字节翻页、可信停止与显式结束 | 客户端窄测覆盖原键、丢答、迟到日志、跨会话清空、连续输出及真实页游标；TUI结束后保留当前状态页，上一页仍沿原游标返回；重连成功只清除查询故障提示，保留停止/结束结果 |
| 版本与离线导入不丢新事实 | schema49/协议36精确拒绝旧格式；恢复测试核实后台记录与关闭屏障显式拒绝导入，原档案保留 |

上述测试均在根 `test/`。平台退出码、主命令退出与停止证明各自断言，不能单凭退出码声称网页内容、外部写入或回滚成功。

## 最终本机检查

本机 Darwin 27 / arm64、Node v24.15.0。macOS真实监督器用例独占串行，避免旧受限模式的全UID孤儿核实互相干扰；应用离线runner已登记独占清单，真实模型与browser默认关闭。

| 实际命令 | 结果与原始输出 |
| --- | --- |
| `npm run build` | 通过；含原生监督器、独立后台worker及两产品制品，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fbuild.log) |
| `npm run check:static` | 通过；lint、根/所有workspace/基础验证类型、笔记与文档门禁，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fcheck-static.log) |
| `npm run desktop:build` | 通过；Electron打包及macOS arm64 ad-hoc签名，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fdesktop-build.log)；未做发布公证 |
| `npx tsx --test test/background-processes-core.test.ts test/background-process-clients.test.ts` | 29/29，无跳过，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fcore-client-tests.log) |
| `npx tsx --test --test-concurrency=1 test/background-processes.test.ts test/background-processes-recovery.test.ts` | 7/7，无跳过，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fmacos-background-tests.log) |
| `npx tsx --test --test-concurrency=1 test/native-macos-identity.test.ts test/101-native-macos-helper.test.ts test/100-worker-stop.test.ts` | 独立上下文亲验60/60，无跳过，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fmacos-native-tests.log)、[专项审查](macos-scope-review.md) |
| `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/15-tui-pty.test.ts test/66-control-seam.test.ts test/desktop-terminal.test.ts` | 95/95，无跳过，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fclient-regression.log)；后台专属翻页收尾补修另有上述29项 |

此前按影响执行的普通工具/审批/账本、目录占用、队列/收尾、owner-question、view及产品入口/导入回归均通过；不把重叠的测试组累加成独立覆盖量。没有运行全仓 `npm run check` 或完整CI版本矩阵。

## 真实Linux

`ssh tx` 的隔离临时副本，Ubuntu kernel6.8.0-117、systemd255、Node v24.21.0。只停止本次探针创建的scope/PID，未调用真实模型或外部业务服务。

平台窄测27/27及真实进程场景覆盖普通setsid后代、继承双管道、主进程退出、宿主/主进程SIGKILL后独立停止、同引用拒绝二次启动、错误InvocationID/指纹/inode以及真实同名scope换代不误杀。原始[命令](linux-platform/commands.txt)、[进程探针](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-platform%2Frun.log)、[身份拒绝](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-platform%2Fchecks.log)、[测试](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-platform%2Ftests.log)、[清理](linux-platform/cleanup.json)与[源码SHA](linux-platform/source-manifest.json)保留；低层小快照及重建脚本一同保留。主动另建scope脱离执行单元单列为完全访问例外，已清理本次夹具。

完整Runtime/core隔离集成实际执行 `node node_modules/tsx/dist/cli.mjs --test test/background-processes.test.ts test/background-processes-recovery.test.ts test/background-processes-core.test.ts`，19/19、无跳过，含真实HTTP跨轮、16 MiB、短写/EIO、关闭竞争及宿主强杀冷恢复。580个源码/worker文件SHA匹配，[最终测试](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-integration%2Ftests-final.log)、[清理核实](linux-integration/verification.json)、[当时内容SHA](linux-integration/source-final-manifest.json)与[独立结论](linux-integration/review-summary.md)保留。初次缺quickjs依赖的[失败日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Flinux-integration%2Ftests-initial.log)未删除，复用已有安装的纯JS/WASM后通过，没有下载新依赖冒充原前提。

Linux集成对应当时快照；此后Linux启动/身份、Runtime接线及Driver未改行为，core增加来源投影/响应字节预算，客户端另有小补修，按当前本机窄测复核。Linux证据不外推为最终macOS监督器或所有Node版本通过；完整原始归档仍位于独立审查报告列出的临时证据目录。

## 真实browser与DeepSeek

固定官方agent-browser v0.39.1（arm64 SHA-256 `cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef`）和本机Google Chrome155.0.8059.85。浏览器路径由环境明确提供，开发服务只绑定127.0.0.1。最终原生helper SHA-256 `5a75956c76faaec1855b215c5c48e0de519fc9d6cc897fb7b30319af0a3aef9b`。

真实browser单独执行 `RUN_BACKGROUND_BROWSER_CHECK=1 RUUKOTO_BROWSER_BINARY=<官方二进制绝对路径> RUUKOTO_BROWSER_CHROME=<Chrome绝对路径> npx tsx --test test/background-browser-acceptance.test.ts`，1/1通过。服务启动→实际browser.start/open/snapshot→下一拥有者轮查询→显式停止，断言实际HTTP访问文件与页面正文进入会话，[原始日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fbrowser-acceptance.log)。模型为桩，明确不算真实模型验收。

拥有者明确授权 `/Users/eitrous/.ruukoto/agent/models.json` 中DeepSeek。最终执行 `RUN_MODEL_CHECK=1 RUN_BACKGROUND_MODELS_FILE=/Users/eitrous/.ruukoto/agent/models.json RUN_BACKGROUND_MODEL=deepseek/deepseek-flash RUN_BACKGROUND_EVIDENCE_FILE=.scratch/agent-tool-completion/evidence/background/model-acceptance.json RUUKOTO_BROWSER_BINARY=<同上> RUUKOTO_BROWSER_CHROME=<同上> npx tsx --test test/background-model-acceptance.test.ts`，1/1通过，[日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Fmodel-acceptance.log)、[实际工具序列与估算](model-acceptance.json)。隔离档案只复制所选提供方/模型，临时models.json在finally删除，配置正文与凭据未入库。

三条真实拥有者消息分别完成：一次process_start并读URL、browser实际访问并回答随机页面短码；下一轮process_status及stdout/stderr查询；第三轮process_stop、status核实stopped/stopVerified，再write写入准确内容。所有工具操作均成功，服务仍运行时没有目录写入，最后占用为空。随机短码对照实际网页、HTTP访问文件与最终文件内容分别断言，区别于只检模型文本或工具退出。

## 模型实际输入与估算

| 阶段 | toolSchemas | systemPrompt | 依据 |
| --- | ---: | ---: | --- |
| 改前完整工具 | 11747 | 1505 | 独立旧提交、独立依赖、相同cwd、一次mock实际SDK请求、0工具；[条件与复现](prompt-before/README.md)、[选择记录](prompt-before/selection-record.json)、[完整快照](prompt-before/prompt-snapshot.json) |
| 改后完整工具 | 12944 | 1505 | 真实DeepSeek首轮，[完整快照](prompt-after/full.json) |
| 后台观测 | 2027 | 1505 | 同一真实DeepSeek链，5个工具，[完整快照](prompt-after/observation.json) |
| 停止并重新取得目录 | 12944 | 1505 | 业务工具恢复，[完整快照及前轮结果](prompt-after/restored.json) |

改动前后差值为toolSchemas +1197、systemPrompt 0；观测阶段收窄另列，未冒充改前基线。快照捕获点为SDK委托提供方之前，不等同提供方适配后的HTTP请求体；入库只补文件末尾单换行，原快照字节哈希按无新增换行正文计算。完整系统提示、工具参数描述、资源阶段、启动来源、状态/输出/停止结果均在快照可查；Plan/受限分叉由实际SDK定向测试验证，没有用真实DeepSeek重跑每种身份或其他提供方。

## 独立审查与边界

[上层独立审查](upper-initial-review.md)、[最终core/Runtime复核](upper-final-review.md)及[macOS范围专项](macos-scope-review.md)无未解决阻断。UI作者的自检明确不算独立审查，客户端安全与分页另外由专项上下文[独审](ui-final-review.md)，重连提示增量[复审](ui-reconnect-review.md)与[实时刷新/动作应答及跨会话迟到结果](ui-action-review.md)复审通过。审查期间发现并修复了输出排空证明、关闭水位、严格pending目录读、完整响应预算、TUI游标与macOS启动期宿主范围污染，相关反例均能捕获撤去修复的行为。

macOS真实browser组合曾使全UID未知孤儿启发式误认浏览器daemon；最终只在持久完全访问模式累计历史受管PGID/SID/已知PID，根命令完成setsid前跳过宿主范围，集合只用于保守拒绝，信号仍用完整寿命身份及audit token。旧受限全UID规则保持。五个真实逃离/漏采反例和启动竞态桩回归通过，拒绝过的方案与负控制见[专项实验](macos-browser-scope.md)。

真实客户端完整链现已通过，详见[复现及结果](real-clients/README.md)。Python标准库PTY运行正式Coding TUI，真实Electron使用最终out的隔离副本，仅加show:false；使用真实preload/IPC/ControlClient与Runtime，没有注入bridge。实际process_start产生随机stdout/stderr，双端均从控件读出；请求单停后核实HTTP断开和stopVerified；退出整个客户端后另一后台仍存活并持有目录，重新连接再确认“结束本会话后台”，核实关闭记录、停止和占用清空。[TUI原始输出](real-clients/final-tui/tui-end.json)、[Electron实际控制调用](real-clients/electron4/control-calls.json)、[最终状态](real-clients/electron4/final-state.json)及[截图](../../../git-history-cleanup/archive.md?path=.scratch%2Fagent-tool-completion%2Fevidence%2Fbackground%2Freal-clients%2Felectron4%2Felectron-end-stopped.png)保留。所有12个本次HTTP夹具PID均不存活、URL均拒绝连接，[清理核实](real-clients/cleanup-verification.json)通过。

真实PTY暴露的旧offline/动作进行中提示有[原始对照](real-clients/tui-regressions-before.json)；最终TUI恢复精确文案断言并通过。Electron早期脚本的环境变量、Radix pointer交互与关闭动画目标错误均保留在临时证据目录，最终改发真实CDP鼠标事件后全链通过，不将脚本错误当作产品失败。此后两端确认说明仅把“登记停止屏障”改为“停止并核实本次结束请求涉及的后台”，按钮/请求与行为不变，桌面制品重新构建。模型仍为mock，不将该客户端证据冒充DeepSeek验收。

工程验收与本切片产品验收通过，无未解决阻断；沿既有组件和已确认的先停后改、显式结束边界，没有新增待拥有者决定的主观风格取舍。拥有者在验收后明确授权提交；推送、合并和发布另行安排。

未验证真实断电/系统重启、实际磁盘满、内核PID/PGID/SID完整回收循环、完整CI版本矩阵、其他模型或前台IME。强杀/冷恢复、短写与EIO为明确列出的替代故障场景，不冒充这些证据。完全访问主动脱离且从未纳管、关闭原管道的进程及外部服务仍属既有回收例外；未知停止继续保留占用。旧档案需匹配版本查阅，不能手改schema或清空以求启动。
