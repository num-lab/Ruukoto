# 个人适配最终组合验收

2026-10-21；工单[04](../../issues/04-personal-adapters.md)，基点 `5739a291`。本证据在提交前采样；拥有者随后授权提交本单，未推送、部署或修改日常档案。[源码及worker SHA256](source-sha256.json)绑定最终组合，模型成功记录中的16个源码与制品哈希已逐项与根工作区核对一致。

## 结果与范围

检索、持久提问、会话后台和共享目录认领均已合入个人独立durable；没有导入Coding的业务存储、审批或Task。后台沿已有个人Linux命令执行能力，不扩展个人macOS后台。`extensions.personal=2` 精确拒绝旧业务档案，不自动迁移或清空记录；本次验收全部使用隔离新档案。

文件检索沿tools资料根，在原生只读worker执行；持久提问的答案使用独立answer-admission和唯一续接；后台归主会话，启动轮结束或取消不级联停止。后台starting、普通命令prepare/start和文件写批准消费共用事务目录认领，未知停止或相应未知效果保留认领。恢复双向核实原记录，命令只执行一次。

两条组合回归覆盖：后台运行时提问使当前轮只保留status/output，答案新轮仍受后台工具策略约束；answer-admission早于关闭、续接main entry晚于关闭时，仍按原接纳水位拒绝启动，零launch且无新claim。统一策略在请求准备、规范输入记录和实际payload记录均取交集；定时和子工作不获得ask_user/process_start。

## 本机检查

| 检查 | 实际结果与证据 |
| --- | --- |
| `npm run build` | 原生、四worker、script及两个产品打包通过；两处来源兼容补修后另执行 `npm run build --workspace=ruukoto` 刷新个人制品，见[最终打包](app-build-final.log) |
| `npm run check:static` | 最终lint、全部workspace与foundation类型、notes和docs门禁通过，见[完整输出](static-final.log) |
| 后台、提问、命令、工具、durable、定时6文件 | 首轮125计：123通过、1真实Linux本机跳过、1定时检索超时；[原输出](combined-first.log)保留失败。原生检查结束后同代码单独重跑超时用例1/1通过，见[重跑](scheduled-search-final.log) |
| CLI、QQ、Telegram、权限、服务、工作工具、产品入口8文件 | 首轮317计：312通过、1既有跳过、4失败计数，见[原输出](entry-first.log)。其中来源兼容两项已修复；服务取消用例单独及完整服务回归重跑通过。最终权限/服务/服务操作3文件202/202，见[修复后回归](sources-final.log)；最终产品入口15/15，见[入口](product-entry-final.log) |
| 工具控制/IO、命令执行/worker、调度权限、浏览器、委派、报告8文件 | 131/131，见[回归](other-final.log) |
| 新增问题与后台组合 | 2/2，见[交集与水位](policy-combination.log)；类型检查补充了scheduled判别，未改运行行为 |
| macOS真实原生与只读检索 | 串行18/18，见[原生检查](native-macos-final.log)，包含持久停止、同ID不重放、身份替换、背压、环境过滤及检索原流/取消 |

未运行全仓 `npm run check`。首轮并发超时和取消停止观察失败均原样保留，不涂成首轮全过；最终相关重跑没有剩余失败。来源兼容补修保留旧无权限快照IM服务的历史恢复和效果核实资格，拒绝新消费；可信本机可以给IM工作补资料，IM来源仍必须原入口。

## Linux与真实模型

Linux隔离源码为 `tx:/tmp/ruukoto-personal-04.YNFVXZ7o`，user systemd/cgroup v2、Node24.21.0。宿主没有全局rg，本次只用既有隔离工具链中的rg14.1.0，不改系统依赖。真实后台scope启动、第二拥有者轮保留、显停核实、释放认领及重开不重放1/1通过，见[日志](background-linux.log)。Linux原生只读检索与durable/定时检索各2/2由[检索证据](../personal-search/)持有。Linux命令恢复6/6和共享claim2/2分别见[命令](claim-linux.log)、[认领](shared-claim-linux.log)；prepare崩溃用例是在真实提交后注入异常，不宣称真实SIGKILL。问题的三处真实SIGKILL由[提问证据](../personal-questions-acceptance.md)持有。

真实模型统一沿拥有者指定的 `/Users/eitrous/.ruukoto/agent/models.json`，选择 `deepseek/deepseek-flash`。检索实际完成list_files→search_files→read_file并取得随机口令，4次请求；提问实际完成登记、普通聊天保持pending、多选/Skip/自由口令、唯一续接和答复时权限下的read_file/write_file，6次请求。原证据分别见[检索](../personal-search/model-summary.json)与[提问](../personal-questions-model/README.md)；最终公共策略由本次组合回归复核。

最终组合真实后台完成四个拥有者轮次：start并从原stdout取URL；下一轮查询stdout/stderr及running；stop后实际status核实stopped/stopVerified；write_file重新取得并释放目录。13次真实请求，保存26条规范及payload记录。另以宿主fetch真实访问该URL并取得随机页面码；明确属于HTTP验证。原进程已退出、HTTP不可达、原cgroup为空、两个claim已释放，隔离模型档案已删除，凭据环境恢复且文件扫描通过。详见[成功运行](../personal-background-model/runs/2026-10-21T09-23-09.054Z-78e4f570/result.json)、[清理](../personal-background-model/runs/2026-10-21T09-23-09.054Z-78e4f570/cleanup.json)及[入口说明](../personal-background-model/README.md)。

同口径UTF-16字符数/4向上取整估算：检索新增schema 4233→4704、systemPrompt119→119；提问新增schema4235→4476、systemPrompt119→119；最终真实后台首请求新增schema4726→5173、systemPrompt137→137。前值均从同一实际请求移除本切片新增工具取得，未伪称另外一次模型请求；后台后续观测阶段schema为563，详见[全部请求估算](../personal-background-model/runs/2026-10-21T09-23-09.054Z-78e4f570/request-estimates.json)。

后台probe首次真实运行因脚本把durable事务代理带出commit而失败，修复为在commit内序列化事实；第二次仅模块加载失败，没有新模型请求。失败输出与首次运行保留供审计；最终成功只对应上述第三次运行。首次失败的服务也已由正常关闭停止，原scope已核实为空；不将探针错误当生产实现通过。

## 独立审查

独立上下文 `plan_delta_review` 逐片及根组合审查无未解决实现阻断，亲跑根问题/后台28通过、1真实Linux本机跳过；新增工具交集1/1；两处来源兼容返工4计全过。其审查涵盖来源水位、共享工具策略两请求边界、原平台菜单、恢复正反链、claim竞争和失败保留；源码作者的本机自检不替代该结论。另一独立上下文 `dependency_audit` 只读复核合并后的检索/claim、source、profile、CLI分组和worker装配，并亲跑Linux关键窄测。

## 尚待产品环境验收

真实QQ/Telegram仍缺专用账号和配对凭据，模拟API/OneBot与原菜单测试不替代真实IM。已经创建并用真实PTY打开隔离入口 `tx:/tmp/rk-personal-im-prep-79x71a/profile`，确认Telegram/QQ配置入口可见后退出，未配置平台、未启动后台或连接账号。其[操作步骤](../personal-im-preparation/README.md)、[准备事实](../personal-im-preparation/prepared.json)与[菜单核实](../personal-im-preparation/menu-smoke.json)可直接交给拥有者继续验收。

Linux Chrome预检报 `No usable sandbox!`，当前浏览器配置不提供noSandbox，未降低隔离要求。真实“后台服务→浏览器访问→跨轮→停止→写入”链路尚未验收；恢复条件是提供能使用sandbox的浏览器环境，再按原工具访问真实后台URL。宿主HTTP成功不记为browser通过。

工单保留 `ready-for-human`，下一责任人为拥有者或提供专用测试入口的环境验收者。完成真实IM和浏览器链路后再由独立上下文核实证据并决定是否resolved；当前不作发布或生产接管结论。
