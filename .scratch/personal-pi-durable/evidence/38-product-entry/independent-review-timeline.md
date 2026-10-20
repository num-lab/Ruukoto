# 工单 38 独立实现审查

审查者：implementation_review（独立上下文，只读仓库源码与文档）；基点：12b1a66c；对象：主工作副本当前源码、测试、部署模板与合入文档。仅在 /tmp 创建隔离副本、假模型配置、PTY 脚本与日志；未启停生产、未调用真实模型或 IM、未提交。

当前结论：源码与文档无未解决阻断。正式 main/bin、根 start、兼容入口同归 runPersonalCli；默认新 durable 档案与旧格式拒绝、开发 realpath 散列隔离及 IM 启用拒绝符合要求；薄 legacy-product 只有测试所需 RuntimeProduct 声明，无旧调度或服务工具搬迁；旧个人工具及导入器删除未发现 Coding/历史调用方损伤。实际 workspace 解包安装、生产平台及最终组合证据由任务汇总者另验，本结论不替代它们。

## 独立亲跑

- `npx tsx --test test/personal-entry.test.ts test/71-product-entry.test.ts test/102-branch-session.test.ts test/125-agent-wait-import.test.ts test/122-workflow-code-acceptance.test.ts`：44/44 通过、0 跳过，104.1 秒；包含 Coding 六输入、schema/JSONL/导入回退、新个人实际进程。此轮在 dev 监督器调整前执行，dev 调整的失效范围由下列最终 7 项与 PTY 复核补齐，其他路径未变。
- `npx tsx --test test/personal-entry.test.ts`：最终 dev 源码 7/7 通过、0 跳过，19.2 秒；覆盖正式/开发实际 import 图、双 Pi 分别解析、正式默认新目录与旧档案原字节、三入口重启、双进程、两产品同时运行与 Coding schema、启动中停止意图、TERM/HUP、开发 IM 拒绝、源码重载和锁释放。
- `npm run check:docs`：通过。169 文件相对链接/锚点、309 源码文档引用、8 常驻文档预算、169 文件段落形态。随后小尾项为文字/既有测试路径补充，汇总者正在跑最终全仓静态及测试。
- `python3 /tmp/r38-independent-pty-signal-probe.py`：配置菜单的 SIGINT/SIGTERM 均 exit 0、owner.sqlite 可独占；外来持锁后台使菜单启动拒绝 profile_busy，退出菜单后外来 PID 存活、token 不变、/status=200。日志目录：/tmp/r38-pty-72xadznc/，文件 SIGINT.log、SIGTERM.log、foreign-lock.log。
- `python3 /tmp/r38-independent-pty-fixed.py`：最终开发启动器真实 PTY 选择 6→2 启动、7 退出，进程 exit 0、锁释放、无 watch 等待；默认 dev 只向父 PID 分别发 INT/TERM/HUP，均 exit 0 并释放锁；INT 轮还修改临时副本源码，确认 token 轮换与 /status 恢复，无 profile_busy。日志目录：/tmp/r38-pty-d7oel8k2/，文件 menu-exit.log、SIGINT-default.log、SIGTERM-default.log、SIGHUP-default.log。

## 发现与关闭

- 初版给 --config 套 Node watch：用户选退出后后台虽然停止，watch 监督进程仍活并等待源码，违背退出结束本次开发运行。`python3 /tmp/r38-independent-pty.py` 复现，日志 /tmp/r38-pty-caw44cbl/menu-exit.log。修为 --config 直接跑菜单，默认 dev 才用薄监督器托管 Node watch，并转发停止信号后等待；最终 PTY 与进程测试通过，阻断关闭。
- 文档误把 Coding 导入来源写为旧 ruukoto-code（实际只接受旧 ruukoto/未登记产品）、仍称 app 提供已删除的旧调度/服务工具、将旧 service_manage 的重启后自动检查流程误写为新 durable 行为、架构摘要仍称共用控制面：均对照源码返工并已复核关闭。
- 状态图旧动词、笔记错误声称两开发入口均拒绝 enabled IM、检查导航漏 personal-entry：均已修正并复核。

先前 /tmp/r38-independent-pty-lifecycle.py 与 direct.py 等脚本未在等待子进程期间排空 PTY，曾超时；该驱动局限不作为源码阻断。有效信号证据来自持续排空 PTY 的 signal-probe 与 fixed 脚本。

未亲跑 Linux、真实模型/IM、生产服务、完整 A1–A12 或实际解包安装；36 原失败精确归因仍保留为 39/生产切换阻断。未额外重跑全量，由当前任务汇总者的最终 npm run check 提供全仓证据。

## 全仓初轮暴露的调用方补审（进行中）

全仓初轮 `/tmp/ruukoto38-check.log` 的 04、10 失败证明仍有字符串形式的旧个人 main/bin 调用方；初轮已主动停止（exit 130），不记为通过。首轮独立审查遗漏了这些进程调用方，本轮补全 main/dev/bin、动态双产品循环与 ruukoto.mjs 的全仓搜索。调用方修订方案无阻断：共享控制协议与旧 JSONL/恢复验证转到仍在生产的 Coding 装配，退出旧个人 server/开发配置导入行为的用例退役；新个人的生命周期由 personal-entry 与上述独立 PTY 覆盖。04、24/25 的进程崩溃场景从空白临时库首启，转 Code 不加载已归属旧个人档案。原未知效果、审批消费、队列、JSONL、终端恢复及 Code 后端拒绝断言须保留，实际补丁与亲跑结果待补。

## 调用方补审完成

已逐行核对 /tmp/ruukoto38-caller-fixes.patch（SHA-256 dadb19f19159cb3555827a47f022187562b8a0d1bdb0286bf0d09c1b374c303c）及合入主副本的实际8文件。恢复、审批、模式、队列、JSONL、终端和Coding拒绝断言保留；仅退出个人旧server/开发模型导入与旧装配生命周期语义。Code临时四目录与owner清理落实，新环境反例证明继承bogus产品、日常Code目录及owner凭据仍只连接临时Coding后台。当前调用方补审无未解决阻断。

独立命令：`npx tsx --test --test-name-pattern='工具已产生标记但未记录结果时崩溃|首次 assistant 消息前崩溃|后台夹具固定 Coding|mcp：后台崩溃重启|mcp 写：崩溃重启|CLI：set-session-mode|CLI submit' test/04-crash-recovery.test.ts test/10-access-modes.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/66-control-seam.test.ts`。结果8/8通过、0失败、0跳过，43.3秒；未重跑重native/122。

检查对象的10文件SHA-256见 /tmp/ruukoto38-independent-caller-source.json（文件SHA-256 cd7f0ff6c3b207ec4e27a96e7b7ea5d43ce0e88845da1c90eeb7e7f2c5ab0e1e）；运行前后全部一致。日志 /tmp/ruukoto38-independent-callers.log（SHA-256 4890b213b0edf4e8af5a8610c2fb47a173090c3ccc4ecae75c7709af4bf35135）。全仓最终检查由汇总者运行，初轮exit130仍不计通过。

另只读审阅clean pack材料：安装/构建状态、实际解包替换脚本、依赖解析、12/12日志、源清单与制品前后核对相互吻合；当前main的apps/packages/package清单/start相对该快照仅packages/core/src/product.ts注释漂移，先前去注释编译JS相同。后续8测试调用方修订不改变制品运行源码。Linux48材料明确采用复用根依赖+新个人最小依赖安装，不能称为Linux完整干净workspace安装；未发现与其限定结论冲突。Coding mock升级日志4/4通过，保留异常占用档案已明确标记，未称为生产或真实模型验收。

## 最终全仓101失败窄诊断

最终 `npm run check` 的macOS首独占批次44项43通过1失败，101控制通道关闭后的后代回收返回reaped:false/identity_unavailable；runner未执行剩余批次。该全仓命令仍记为失败，后续窄测通过不覆盖或抹去原失败。

按diagnosing-bugs，在同Node 24.15.0和RUN_MODEL_CHECK=0环境仅跑原101失败名称三次，3/3绿；再在已有HEAD=12b1a66c独立docs worktree编译原C监督器并跑同名用例三次，3/3绿。test101、C源码、native-macos.ts、native.ts、构建脚本与HEAD三方SHA相同；独立编译二进制与主树也相同（43441a966e3b6fb3111e57f68077dbee76b008f198e1addb3bcac690d7f85729）。两组结束无本轮夹具进程；没有改主树native或降低断言。完整命令、六轮日志、源码hash和清理记录见 /tmp/ruukoto38-native101-diagnostic/summary.json 与 manifest.json。

归属结论：可登记为38未改动的既有native路径验证缺口；本轮没有稳定复现，不声称已证明基点也失败、精确触发机制已知或组合时序影响已排除。这项诊断不关闭36。38源码/文档及调用方补审仍无实现缺陷阻断，但全仓未通过的事实和其未执行范围必须保留，最终39/生产验收不得据此放行。

共享环境补充：当前只读ps观察到71778→71806→71807→71809的其他长期测试进程（归33926，非本轮38）；未处理未知归属进程。快照见native101诊断目录unowned-test-processes-observed.txt。不由当前ps推断失败瞬间状态或判为失败原因，组合时序/共享环境影响仍未排除。

## 剩余 app 批次 112 高 CPU 与失败（尚未归因）

外层剩余 app 批次中，112 正常退出并流出 14 项中 6 过 8 败，收尾后个人首项 reason=script_cpu_limit、其余7项等待超时；不能报告全仓通过。只读语义核对未发现 thin legacy-product 改变该 Code 用例的产品，Code 配置显式覆盖默认；真实工具、工作目录与本轮 112/122 源码未改。approved-ops/native/runtime/skills/112/122 与 12b1a66c 字节相同，不足以单独证明不存在组合回归。

主代理确认仅作用于本轮自有测试进程后，对自有 PID 49528 做 mac sample 与约 1 秒 CPU profile。精确热点为 prepareNativeLaunch→assertGrantNotProtected→isProtectedPath→identityCovers 的同步目录身份扫描。Runtime 保护根含整个 CODE_ROOT，目录扫描跳过 symlink；主树和 pack 副本 node_modules 为真实目录，docs/tests 副本是链接。作者 115 项在 pack、独立 44 项在主树，均非链接依赖，不能用此环境差异包办解释。采样说明当时高 CPU，不等同于每条失败的精确因果，更不合并 native101/36 原问题。

初次关闭 inspector 后曾发现 listener 仍在，随即对同自有进程再次显式关闭并等待；最终 listener 为空，随后进程正常退出，再次 ps/lsof 均空。未动未知进程。诊断脚本、profile、sample、源 hash、流式结果与收尾证据位于 /tmp/ruukoto38-112-diagnostic/README.md 和 manifest.json；外层日志新增 Debugger 行为本次诊断产生。

## 旧模型工具断言退役补审

只读比对 entry_audit 保留基线与 pack worktree 的 113、115、subagent-source-capabilities 三文件补丁，无阻断。113 仅移除已删除旧个人 schedule_query/notification_query 正向依赖与仅供通知使用的 seed，实际 read_artifact 固定授权、跨运行真实产物/history 双拒绝及正文不泄露均保留，标题同步。115 仅退役已无装配入口的模型 schedule_cancel 自取消专例，宿主 scheduleCancel 运行/取消循环、最终回报与停止核实保留。subagent 移除正向 schedule_query，显式缺工具登记前失败/零模型零账本的负例仍保留。该补审未亲跑新测试，最终补丁对象与作者结果待汇总。

## 部分补跑收尾与最终影响范围

剩余 app 补跑 exit1，2542项中2480通过、40失败、3取消、19跳过，约1306秒；含本轮自有INT，不计最终完整覆盖。详情43个block分组见 /tmp/ruukoto38-app-rest-failure-analysis/README.md 和 failure-groups.json。118 Code 原回答事件数63!=61单列未归因；25等待超时、5 Abort TimeoutError、3测试timeout及文件级中断均保持实际现象，不据112采样推同因。原全仓101仍独立失败。

补审 docs_audit 的40/49/51/85四文件无阻断：QQ认证与真实文件审批，实际群结果接收/固定SQL快照/前后撤回，真实app_data删除审批与保存模式重启、宿主未知停止，以及归档来源撤回/映射篡改/重启幂等均保留。只退出无装配入口的模型通知与自取消语义，未恢复旧工具。51新增pending confirmation.toolName=app_data_delete增强替代审批证据；最终源hash待作者交付确认。

late工具调用方/提示词修订后，此前完整批次与独立窄例保留为对应版本证据，不能改记为最终组合通过。共享Driver只删scheduled系统提示中指向退役notification_enqueue的句子，源码方向无阻断；按agent-facing-text仍须最终实际scheduled prompt/工具清单与前后估算数字。该运行文本变更使先前pack快照不能再宣称最终运行代码完全等价，但未变入口/依赖解析/新个人worker的已测范围仍有参考效力；受影响scheduled范围由最终窄验补齐。不将未完成检查转成通过，产品体验/真实平台/36/39/生产阻断保持。

## late 系统提示残留（待最终快照复核）

按agent-facing-text审查完整before SDK快照，发现notification_enqueue实际出现两次：Driver的scheduled追加句和SYSTEM_PROMPTS.main基础句。只删Driver追加句仍会把退役工具指导发给模型，已作为阻断报汇总者；基础main同时残留旧service_inspect/service_manage整段说明，也已请求核实无现存装配后清理。新个人durable独立提示不在此删除范围。before快照systemPrompt估算2088、toolSchemas10737，实际工具清单没有notification工具；源/快照与发现见 /tmp/ruukoto38-shared-prompt-review.json。最终after实际快照、main/scheduled两身份及新负例通过后才能关闭此项，当前不把“源码方向无阻断”误当残留已清完。

## 最终提示与文案终审

上述late系统提示阻断已关闭：实际main/scheduled前后完整SDK/HTTP快照、估算与工具逐项一致性均亲读确认，主树三文件hash匹配；完整最终结论改以 /tmp/ruukoto38-independent-final-review.md 为准。未发现剩余源码/文档实现阻断，38工程验收仍待验证；原全仓失败、部分宽批次和36缺口保持。
