# 应用数据 durable 接线证据

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

基线 `8bbcbc4abb4d3c7c5268ef172b72798d09636ebb`，macOS arm64 / Node 24.15.0；未修改正式入口、生产档案或部署。使用真实SQLite、原生durable Harness、离线OpenAI兼容模型替身和QQ/Telegram传输替身；Linux窄验见下文，真实模型/IM另行验收。

## 实现与窄反例

`test/personal-app-data.test.ts` 覆盖六工具、同轮多调用独立op_id、完整参数指纹、业务与审计同事务、跨重启结果、受限两模式人工批准及full_access免审批、多行及破坏性迁移、批准后revision/权限失效、子工作显式资格与身份复用、独立定时及只读汇总。查询64KiB预算内的长结果在实际下一次provider payload仍完整。

独立子进程在应用库已提交、durable observation尚未提交时SIGKILL，重启仅按原键补结果，业务行与insert回执各一次。缺库、换库、合法JSON内容损坏、回执键损坏和回执行被删除五种反例保持未知；原来源拒绝再委派，独立新聊天继续。恢复可信原库后可按原记录核实，不重放修改。初始化身份已durable提交而业务库尚未创建时SIGKILL，恢复只完成无业务操作的原初始化意图。

人工重核在start持久化、原工具未结束的窗口明确拒绝，避免过早宣称未提交；正常工具写后核实和启动resume前核实不使用此人工资格。共享AppDataStore仍允许同父Task下多个op_id，不把旧Task当工具操作键。

`test/personal-cli.test.ts` 以本机令牌认证API走列表、批准、空POST回执重核及CLI选择/详情；错误令牌拒绝。Telegram用例覆盖原已送达菜单、错回复拒绝、失效批准记决定但不消费及重启；`test/personal-qq.test.ts` 覆盖QQ完整业务、同账号/owner/代次的Telegram回复仍不能批准、原QQ批准与重启。

## 实际模型输入

`after-requests.json` 是5种装配的实际离线provider payload：主、未授权子、明确授权子、定时初轮及最终汇总。前值复用基线提交已保存的 `../33-memory-skills-history/after-requests.json`，不是从源码估计工具清单。`capture-requests.mts` 可复跑；system正文与完整tools JSON字符数除4向上取整仅作估算，不设窗口上限。

| 身份 | systemPrompt前→后 | toolSchemas前→后 |
| --- | --- | --- |
| 主 | 107→107 | 1799→3302 |
| 未授权子 | 69→69 | 709→709 |
| 明确授权子 | 69→69 | 709→2187 |
| 定时初轮 | 78→78 | 999→2494 |
| 定时汇总 | 78→78 | 999→1306 |

定时汇总只新增app_data_query；未授权子不新增应用工具，明确授权子在本次工作结束后移除资格。工具定义及返回参数从持久请求快照与原助手/工具entries重建，实际执行与SDK标准化后的参数一致。

## 独立审查

`app_data_baseline` 在实施前核对原规格与方案，并审共享存储/查询、来源、双库恢复、工作/委托/定时/报告暂停及文档；初次17/17新用例与40/40旧应用数据回归亲跑通过，最终增量13/13通过。`app_data_controls_review` 独立核对本机、双平台菜单及恢复，新增2/2入口与既有3/3平台隔离用例通过；另用真实Harness在start已提交窗口排入人工重核，确认拒绝且仅一次提交。

审查发现并返修共享指纹幂等、SDK规范化比较、首次初始化窗口、回执内容/键损坏、失效批准回链、活动工具提前核实、空POST。最后一次业务终审和入口终审均无未解决阻断；审查者未写根工作区。作者较宽回归发现新增异步空查询清理延后故障闭锁释放，已修并以8/8故障定向回归复核。检查证据只对应实际被检版本，失败的早期日志保留为返工依据。

## 作者检查

`npm run check:static` 通过，见 `logs/static-passed.log`；工单/证据最终文本另跑 `npm run check:docs`。23个相关文件的最后组合为557项，556通过、1项Linux专用跳过、0失败，见 `logs/targeted-final.log`；覆盖旧应用数据/工具可用性/操作账本，以及personal基础、应用数据、CLI、服务、工作/委托/报告、定时、通用工具/MCP和双平台权限。最后组合限制4个测试文件并发，使用离线模型与平台替身；不把跳过项记作通过。未跑全量 `npm run check`，未改变依赖或构建入口。

## Linux窄验

`app_data_controls_review` 在 `ssh tx` 的独立临时副本执行，Linux x64 / Node 24.21.0 / npm 11.19.0；运行前后核对549个源码、测试、worker和配置文件SHA-256，均零差异。复用已有维护依赖及本机新Pi依赖副本，未联网安装、未改远端既有检出、未调用系统sudo。命令、版本、依赖元数据、输入清单和完整TAP见 `linux/`。

应用数据完整文件23/23、QQ应用数据批准1/1、本机应用数据及Linux服务HTTP2/2，合计26/26通过、0失败、0跳过，详见 `linux/summary.json`；最后一项补验macOS组合跳过的Linux专用用例，其sudoPath为测试临时转发脚本。测试使用离线模型和平台替身，不代表真实模型或平台验收；本次窄验也不代表完整CI矩阵通过。清理前专属路径存活进程为0，远端临时副本已删除，见 `linux/cleanup.json`。

## 外部证据缺口

`verification/smoke/smoke-personal-durable.mts` 已增加模型建表、单事务两行插入、独立后台重启查询及SQLite/原工具结果核实。本轮实际退出2，缺少 `RUN_MODEL_CHECK=1`、`RUN_PERSONAL_MODELS_FILE`、`RUN_PERSONAL_MODEL`，零真实模型请求，见 `logs/real-prerequisites.log`。没有把离线provider或传输替身记作真实模型/平台通过。

真实模型结构化事务、QQ/Telegram实际操作、操作者体验及完整CI矩阵仍待专用环境补证，34保持待人工验收；定时与最终报告的外部组合由32/35/39共同核实。未提交、合并或部署，不把本次工程交付记作正式迁移完成。
