# 工单 38 最终独立实现与证据审查

审查者 implementation_review，独立于实现与测试作者；基点 12b1a66cfa661f2a8bddaa9405283ab9f22cb20c。只读主树，验证脚本、日志与隔离副本位于 /tmp；没有写生产档案、调用真实模型/IM、提交或推送。按 development-workflow、error-handling、pre-push-checks、prose-standard、writing-docs-for-human、agent-facing-text 与 diagnosing-bugs 审查。

最终结论：本轮已审源码、测试调整及文档未留待修的实现阻断；38 保持 in-review，最终工程验收仍待验证。正式入口隔离实施完成与全仓验收通过是不同事实；当前 npm run check 明确失败，后续窄测不关闭原失败、宽批次残项、36、39 或生产切换阻断。拥有者实际体验及真实模型/渠道组合仍待验。

## 实现与安全边界

main/bin、根 start 与兼容 personal-entry 同归 runPersonalCli；默认新 durable 档案、旧格式拒绝和两产品独立路径符合要求。开发目录固定为检出 realpath 散列，清洗继承的正式产品/控制环境；配置菜单本进程持有后台，默认 watch 仅监督自己派生的子进程，INT/TERM/HUP 等待收尾。启动中停止意图保留；开发档案启用 QQ/TG 时在恢复/连接前拒绝；外来持锁后台不被菜单退出停止。

旧个人 product、scheduler-tools、service-tools 与 personal-import 已删除，薄 legacy-product 只声明旧格式共享测试需要的 RuntimeProduct，工具族为空。Coding 装配、导入器、schema/JSONL/恢复与新个人仍用的服务 helper 保留；未把退役 CLI 或模型工具复制进夹具。

字符串进程调用方补审后，旧共享协议的真实后台、CLI、PTY 和崩溃恢复转到 Coding，临时四目录及 owner 环境清理保持隔离。原 SIGKILL、未知效果、队列、审批、JSONL、终端及 Code 后端拒绝断言保留。后续七文件旧工具断言退役没有删除共享安全回归：实际产物/历史固定授权、跨运行隔离、QQ 控制面认证和真实文件审批、群结果固定快照与前后撤回、真实 app_data 删除审批及重启模式、宿主取消未知停止占用、归档映射篡改和恢复幂等均继续受检。

## 独立亲跑与补审

独立亲跑入口/71/102/125-import/122 五文件 44/44、最终入口 7/7、恢复/MCP/CLI 窄选择 8/8，均无跳过；check:docs 通过。三组命令和对象指纹在原独立审查摘要及 /tmp/ruukoto38-independent-caller-source.json，不能相加成唯一总覆盖。入口与历史/Coding 检查早于晚期共享提示修订，后者影响范围由下文最终快照和相关窄验另证。

独立真实 PTY 找到并复现初版配置菜单退出后 watch 仍存活，修正后选择6→2启动、7退出结束进程并释放锁；默认开发父PID单独INT/TERM/HUP均退出，源码重载token轮换；配置菜单信号退出释放锁，外来PID/token/status保持。有效脚本为 /tmp/r38-independent-pty-signal-probe.py、/tmp/r38-independent-pty-fixed.py；对应日志目录 /tmp/r38-pty-72xadznc 和 /tmp/r38-pty-d7oel8k2。早期未排空PTY导致的驱动超时保留为验证器局限。

只读核对实际 clean workspace setup/build、app解包替换、Pi双版本与worker运行12/12证据；Linux48明确是复用共享依赖加个人最小依赖安装，不是完整干净workspace安装；Coding mock升级4/4的异常占用为脚本有意播种，不是新OS停止失败。旧pack/Linux/升级证据对应自己的源码版本，不能声称覆盖最终全部运行文本。最终七项worker/app制品对照相同，也不能替代共享源码提示的独立验证。

## 模型提示残留已关闭

独立审查完整实际SDK快照发现 scheduled 追加句与基础 main 均指导已退役 notification_enqueue，基础 main 还描述旧 service_inspect/service_manage。仅修 Driver 的中间版本新负例3/3失败，随后同步清理 session-factory 的基础提示，阻断关闭。

最终主树 driver、session-factory、115哈希与作者清单相同。main/scheduled 两身份的 SDK system 与实际 HTTP system 均无这三个旧工具名；本身份完整 SDK tools 和 HTTP tools 前后逐项相同。固定目标一次最终回报、无目标保存结果、独立上下文/保存模式、Telegram/QQ纯文本与不用Markdown仍保留。宿主估算 scheduled systemPrompt 2088→1790、toolSchemas10737不变；main1862→1613、toolSchemas11265不变。115消息正文和system双负断言能击中原残留，success/retry/cancel闭环保持，作者最终3/3；主树59另2/2。审查记录 /tmp/ruukoto38-shared-prompt-final-review.json，增量patch SHA-256 7da5870b8b67cc259a88d02fe27a22590ef3b5c706f819b2ccb5268d2f954e0a。此段为源码、快照与作者结果补审，没有再亲跑测试。

## 失败事实与诊断边界

最终 npm run check 构建/静态通过，但首串行批次44项43过1败，101回收后代返回 reaped:false/identity_unavailable。当前同名最窄3/3、基点原源码独立编译同名3/3，五份测试/原生/构建源码及二进制相同，没有稳定重现；不能据此证明基点也曾失败、断言精确机制或关闭36。六轮命令、源hash与自有进程清理在 native101-diagnostic。未处理未知归属的长时间测试进程，也不由后来ps推断原失败瞬间状态。

剩余 app 部分补跑2542项中2480过、40败、3取消、19跳过，约1306秒，实际4个自有文件被有界INT，且测试/提示随后修订；不算最终完整覆盖。失败详情43个block包含旧工具契约、等待/HTTP超时、112脚本CPU预算、118事件数63!=61及文件级中断，逐项分组在 app-rest-failure-analysis。112采样精确命中 identityCovers 同步保护目录身份扫描；采样只说明该瞬间热点，没有量化证据目录增量，不能将全部失败或原101/36归为同因。主树/pack依赖是真实目录，docs/tests副本为链接；作者115与独立44均非链接依赖，不能以链接跳过扫描解释其全部差异。

主代理确认仅作用于本轮自有测试进程后，为112取约1秒CPU profile；首次close未彻底关闭后再次显式关闭并等待，最终无listener，PID正常退出后再次核实无9229监听。没有暂停或读取业务对象、没有停止未知进程；Debugger日志为本次诊断副作用。

随后主树32单独25/25、112关键三项+118 Code+122共5/5、主提示2/2与定时3/3均有日志，最终静态和worker构建通过。这些结果只补对应窄范围，不抹去原全仓失败、宽批次未归因项和中断范围。

## 最终文案与交接

已事实终审38工单、证据README、remaining-work、新入口决策笔记和36新增缺口段。它们正确记录隔离实施完成、工程仍待验证、产品待验、原始失败不被绿测覆盖、实际四次自有INT、共享提示晚于旧制品快照，以及36/39/生产阻断；未发现相互矛盾的放行声明。决策笔记的implemented描述已落实决定，不表示工程验收通过。

最后审查对象的30文件SHA及四条删除路径见 /tmp/ruukoto38-independent-final-source.json。后续责任是保留现场并诊断全仓原生/宽批次残项，再按39验证最终候选；本审查结论不取得生产切换授权。
