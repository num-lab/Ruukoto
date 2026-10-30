# 37 当前真实流程验收

2026-10-18，接手基线 `63a52f46c3af9b1d14bf61e7045b40fc477d9043`，开始时工作区干净。本轮完成[工单 37](../../issues/37-current-live-flow.md)限定的当前 A2/A3/A5/A6/A8/A10/A11 子集；工程及实际拥有者流程通过。修复过程中保留各候选与失败原文，不把历史不同候选拼成最终全能力通过；QQ、MCP、调度、完整 A1–A12、正式入口和生产切换仍由后续工单承担。

## 证据入口

| 材料 | 内容与边界 |
| --- | --- |
| [最终 SQLite](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F37-current-live-flow%2Flive-linux%2Fpersonal-live.sqlite.gz) | Linux 实际档案，495 entries、228 tasks、115 documents、478 revisions；168 条模型请求记录组成 84 对基础输入/实际 payload。原模型回答、真实 TG 控制收件与送达事实均保留 |
| [执行归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F37-current-live-flow%2Flive-linux%2Fruntime-records.tar.gz)与[清单](live-linux/archive-manifest.json) | 123 个文件，含完整 SQLite 备份、逐阶段控制快照、6 次后台身份、原生命令 claim/输出、helper claim/操作证据、测试服务与计数；逐文件大小和 SHA-256。排除 private、control.token、锁库及进程环境；实际 token/模型密钥及编码变体扫描零命中 |
| [最终源码与检查](live-linux/final-checks.json)及[改动快照](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F37-current-live-flow%2Flive-linux%2Ffinal-change.diff.gz) | 对基线的最终实现、测试、文档哈希与实际检查；9 个应用文件与 server6 相符，其余 241 个部署源码匹配基线。旧 source-manifest/checks/record-checks 仅证明最初本机候选 |
| [实际工具估算](live-linux/final-text-estimates.json) | 实际入模完整工具列表与系统正文的 UTF-8/4 估算；主工具 21 个由 6515→6710，子工具 15 个由 3618→3716，系统分别保持 366/196。非供应商计费 token |
| [Linux 清理](live-linux/cleanup-linux.json)与[本机清理](live-linux/cleanup-local.json) | 停后台并取得原锁，精确核实 3 个命令 scope、8 个 helper 启动组、2 个操作单元及测试服务停止，归档后删除专用资源；生产 PID 与标准 helper/策略哈希保持。代理、隧道及临时凭据也已清理 |
| [独立终审](live-linux/final-review.md) | 直接读取实现、回归、实际请求与归档，不以用户按钮或作者摘要替代实际内容；同时保留报告措辞缺陷 |
| [部署审查](live-linux/environment-review.md)、[文本修正](live-linux/text-fix.json)、[服务结果修正](live-linux/service-result-fix.json)、[故障观察器审查](live-linux/observer-review.md) | 原阶段方案、失败尝试、红绿与独立核对；完整逐阶段数据见归档 records/ |

## 实际流程与定位

真实 provider/model 为 `deepseek/deepseek-flash`。macOS 准备并配对专用 Telegram bot，Linux `tx` 的新档案独占接收。tx 无法直连 TG，TLS 经仅允许指定模型与 TG API 主机的本机 CONNECT/SSH 隧道，未替换平台或模型。临时凭据只在受限文件与进程环境；本单没有改生产 bot、标准 helper、标准策略或后台。

Linux 安装当前 helper 的隔离副本，仅替换 `POLICY_PATH` 与 `OPS_DIR`，其协议和操作单元命名保持；白名单只含可回收测试 unit。最小依赖闭包、安装差异、每次后台身份与候选源码均可从归档 records/ 和部署清单重建，不能把专用副本称为生产制品验收。

| 场景 | 实际事实及定位 |
| --- | --- |
| 并发聊天及取消后复用 | group32/work48 执行命令65期间真实聊天返回 `CHAT37_OK`。第一轮拥有者到达菜单时已完成，追加拒绝，不能计活动取消。旧描述令模型传已取消 group32 而失败；修正后同一原文省略旧委托，复用 agent42 建立 group151/work161 |
| 追加、人工审批、原入口报告 | group192/work201 在服务226等待原 TG 审批时接纳补充273，answer285 含 `APPEND37_OK`；原菜单批准并长期授权。计数1→2。唯一 report305/admission306，平台478回复原任务461；拥有者确认只收到一份 |
| 长期授权与撤销 | group342/work350/service364 命中原授权，计数2→3；撤销后新 group399/work408/service422 恢复待审批且未消费。拥有者经 `/委托` 列表→详情取消，停止已核实，422为 `not_executed/source_inactive`，计数保持3，长期身份42仍开放 |
| 自动审查 | group456/work465 只读复查服务226/364，新结果含 confirm/人工或长期授权依据。外部专用非敏感文件 read_file 操作491产生 reviewer claim494、实际无工具请求495、approve496，返回 `REVIEW_37_OK`，未用命令绕过 |
| 完全访问 | group533/work542/command557 在目录外追加恰一行 `FULL37`，stdout `FULL37_OK`，返回0、停止已核实；report585/admission586唯一送达，拥有者确认一份 |
| 真实崩溃及原菜单恢复 | group623/work632/report654先登记。command663 已追加一行 `CRASH37`、stdout含STARTED但无宿主结果，观察器绑定原serve PID/start、claim、scope/cgroup及原计数，SIGSTOP复核再SIGKILL。server4同档案恢复为原效果未知、报告暂停、计数仍1，无重跑；独立聊天返回 `CHAT37_RECOVERED` |
| 效果与停止双核实 | 拥有者用真实 `/命令` 原菜单发起停止重核687/observation690，再确认已生效并提交外部观察说明，resolution698=`applied`。原command663保留 `effect_unknown/interrupted` 历史而 stopped=true；原report654完成并送达平台532，拥有者确认一份，计数保持1 |
| 最终事实更正 | 老 work465 的模型回答503因 `length` 截断，旧报告存在审批/核实误述，均保留。修复后 main 的 result 当前 commands 独立于历史文本，partial逐页显示；本机请求773/answer774正确消费。最后真实TG535→group825/work842，子answer853无工具且事实正确；唯一report856/admission857→answer876，平台537回复535。实际payload837/851/867/875含当前事实、工具和报告参考 |

## 发现与修复

取消后的新任务误传旧委托，修复工具参数说明和既有错误下一步；不放宽已取消委托守卫。服务工具只返回终态导致模型推断“没有审批”，共用结果投影补原模式、消费与批准依据，不另存审批状态。生成截断原先被分页完成掩盖，现从原 stopReason 投影 partial，并贯穿 CLI/IM、scheduler 和汇总参考。恢复后旧子回答盖过当前核实事实，现共享命令结果投影并在 background_work result 返回原工作当前 commands/notice，CLI/IM及汇总优先显示；不改写旧效果、输出或历史，也不再要求已完成双核实的拥有者重复核实。

回归包括取消身份复用、服务三模式/授权、截断分页与汇总、命令三模式及双核实。先红后绿及独立审查见检查与终审；最终 `npm run check:static` 通过。没有新增依赖、权限、Task 状态或持久化格式。

## 保留的产品缺陷与范围

最终 answer876 主体正确，但末句误称“仅留本机”，实际宿主事实为 `sent` 并唯一回复 TG535。这是模型报告措辞缺陷，未修饰或覆盖原文；独立审查确认不推翻实际固定入口与唯一发送验收，后续 39 应对报告中的发送状态与旧上下文污染继续验收。不能称最终正文全部准确或体验无缺陷。先前 work465 真实长回答仍是截断片段，页读完不代表原回答完整；当前界面及新报告已经明示。

本轮中断只覆盖一条受限命令“效果发生而结果未提交”窗口；没有验证所有服务/MCP/工具写类型或每个崩溃点。服务未知效果的 `/服务核实`、检查停止菜单、QQ/浏览器/媒体/调度与业务能力仍待各工单及39验收。原 ready-for-human 工单只补对应证据，不整体关闭。

## 历史本机子集

[model-probe.mts](model-probe.mts)、[model-result.json](model-result.json)、[model-personal.sqlite.gz](model-personal.sqlite.gz)、[model-cleanup.json](model-cleanup.json)、[source-manifest.json](source-manifest.json)、[checks.json](checks.json)、[record-checks.json](record-checks.json)、[review.md](review.md)与[linux-preflight.json](linux-preflight.json)保留最初候选的事实：macOS真模型两项分析复用同一身份，同进程关闭重开后唯一 `local/completed`；13次请求尝试含2次连接错误后重试，11次成功响应、26条请求证据。它没有真实IM、独立进程崩溃或外部效果，不能代替上述Linux证据。原临时档案已在最终归档和锁核实后删除；历史 model-cleanup 中“原档案保留”是当时状态。
