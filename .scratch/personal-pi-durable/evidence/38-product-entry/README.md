# 正式个人入口与旧装配清理证据

接手基点 `12b1a66cfa661f2a8bddaa9405283ab9f22cb20c`，开始时干净。拥有者明确允许 38 先在隔离档案实施，36 原 17 精确归因继续阻断 39 与生产；本单未提交、推送或启停生产。有效要求和后续角色见[工单](../../issues/38-product-entry-cleanup.md)，保留/退出逐项对应[能力清单](capabilities.md)。

最终 144 项改动/删除源码与文档由[源码指纹](source-final.json)标识，本目录由[证据指纹](evidence-sha256.json)标识；历史安装、Linux 与中间失败各自使用原快照，不能混为最终一次全仓通过。

## 实现与审查对象

正式 bin、根 start 与兼容入口统一进入个人 CLI，默认 `~/.ruukoto-durable/`；Coding 的根 start 分支与既有入口保留。开发使用检出散列档案，默认薄启动器托管平台 watch，配置菜单直接同进程运行；启动拒绝启用 IM 的开发档案，退出只停止自己持有的后台。旧个人 product、调度/服务模型工具与个人导入器删除，Coding、共享历史 schema/账本及仍用 helper 保留。

通用共享测试继续使用无产品工具族的薄声明。需要真实进程的旧协议、崩溃恢复、MCP、CLI、TTY 与原开发启动器检查转到 Coding；旧个人 server、模型导入和无 TTY 常驻开发场景退出，新个人由 `personal-entry.test.ts` 和真实 PTY 检查覆盖。不复制旧 CLI 或旧工具到夹具。

独立方案审查核对规格、前置与实际 import 图，实施审查直接读取源码、测试和文档并亲跑窄例。[独立审查](independent-review.md)记录初次 watch 菜单退出缺陷及修复、文档事实返工和受影响证据；调用方修订另补审。检查相互有重叠，下面按命令分组，不能相加成总覆盖量。

## 已执行的检查

| 对象 | 实际命令与结果 | 证据 |
| --- | --- | --- |
| 首轮入口与旧 CLI | 入口/个人 CLI/71/29 一组 66 项：65 通过、1 项 Linux 专用在 macOS 跳过；初版 dev 仍缺完整退出语义，不作为最终 dev 通过 | [首轮日志](entry-initial.log) |
| 最终个人入口 | `npx tsx --test test/personal-entry.test.ts`：7/7 通过；正式/根/兼容入口、默认/旧档案、锁、两产品并存与 schema、启动中停止、TERM/HUP、开发 IM 拒绝、重载 | [最终入口](entry-final.log) |
| 旧工具退出后的测试 | 独立副本 9 个保留文件 58/58；helper、旧存储/schema、Coding 导入与共享资料/通知回归保留 | 调用方与退出测试日志在本目录另存 |
| 真实 PTY | 开发菜单启动→退出、信号、外来持锁后台；默认 dev 只向父 PID 发 INT/TERM/HUP，重载前后核实原锁及新 token，均通过 | [脚本与日志](pty/)；结论见独立审查 |
| 独立安装与实际 app 包 | 新副本运行 `npm run setup -- --skip-hooks` 和 `npm run build`，实际解包两个 tgz 替换 app 后 12/12 通过，无跳过；双 Pi 分别解析，worker 实际执行 | [制品摘要](pack-macos/acceptance-summary.md)、[交付指纹](pack-macos/delivery-sha256.json) |
| Linux | Node 24.21.0、普通账户；复用只读共享依赖并独立安装 Pi 1.3 最小依赖；四文件最终 48 项通过，无跳过。worker 独立构建、实际账户/Node 替换后的模板只读 verify 均返回 0；569 份源码前后相符，临时目录与进程已清理 | [Linux 摘要](linux/summary.json)、[原日志](linux/remote/logs/)、[清理](linux/remote-cleanup.txt) |
| Coding 真实安装升级 | `SMOKE24_BASE=12b1a66c npm run test:upgrade`：4/4 通过；两份 Coding 安装独立升级，原审批、产物、JSONL、工作副本及未知占用保持，旧任务不重放 | [升级日志](coding-upgrade.log) |
| 调用方修订 | 独立副本 117 个唯一场景通过，环境加固后重叠复跑 10/10；独立审查亲跑恢复/MCP/CLI 八项 8/8 | [作者摘要](callers/ruukoto38-caller-fixes-summary.json)、[独立日志](callers/independent-callers.log) |
| 两处检查调用方 | workspace 错误断言和已删除 smoke 的测试数组先确认失败，再按两产品契约/现存脚本修正；最终分别 5/5、6/6 | [workspace 前](callers/workspace-before.log)、[后](callers/workspace-final.log)，[smoke 前](callers/verification-before.log)、[后](callers/verification-final.log) |
| 退役工具调用方 | 113/115/subagent 的有效资料/历史与宿主取消规则保留，三文件 35/35；40/49/51/85 的身份、快照、审批与恢复保留，25 个不同用例各有通过证据。原模型通知与取消工具用例退出，不恢复工具或复制装配 | [三文件摘要](tool-retirement/ruukoto38-tool-retirement-summary.md)、[四文件摘要](retired-callers/summary.json) |
| 开发文件复核 | 主树 `node --import tsx --test --test-timeout=180000 test/32-dev.test.ts`：25/25，通过，无跳过；不替代之前整批停滞的归因 | [单独开发日志](dev-final.log) |
| 共享工作流与 Coding 窄复核 | 主树串行选择 112 的前两种产品/验证写回拒绝、118 Coding 入口与 122 编码六输入：5/5，通过，无跳过 | [最终窄日志](workflow-focused-final.log) |
| 最终共享提示 | main/定时两身份实际 SDK 与 HTTP 快照均无退役通知/服务指导；工具清单逐项不变。系统提示估算分别 1,862→1,613、2,088→1,790；工具 schema 估算分别 11,265→11,265、10,737→10,737。定时三例 3/3；主树 59 两例 2/2 | [快照摘要](shared-prompts/ruukoto38-scheduled-prompt-summary.md)、[main 回归](prompt-main-final.log) |
| 最终静态与制品 | `npm run check:static`、`npm run build:worker`、diff 检查通过；最终七项 worker/app 制品哈希与实际 pack 验收一致，晚提示源码变化另计 | [静态](static-delivery.log)、[worker](worker-final.log)、[制品对照](artifact-final-comparison.json) |
| 基础验证 | `npm run test:foundation`：9 项通过、1 项真实模型按离线规则跳过，无失败 | [基础日志](foundation-final.log) |

App tarball 仍依赖完整 workspace 安装及根 `worker/`，本单没有改成独立发行版。macOS pack 证据的 4,045 项原始清单与测试后快照一致。后续除了文档、注释和测试调用方，还清理了共享 `driver.ts` / `session-factory.ts` 的 main/定时系统提示，因此旧 pack、Linux 和升级结果不能声称覆盖最终全部运行文本。两 app 入口与依赖声明保持；提示变化由实际模型快照与窄回归另证，最终候选以收尾清单标识。

## 首次失败与证据局限

全仓首轮静态通过后，04 崩溃与 10 CLI 暴露测试驱动仍调用旧个人 main/bin；本轮主动 SIGINT 停止，返回 130，不记通过。[中断日志](check-interrupted.log)保留原失败和未完成项，随后按实际调用方修订并重新检查。

修订后的 `npm run check` 构建与静态通过，但 runner 首串行批次 44 项中有 1 项失败：101 macOS 监督器回收已累计后代返回 `reaped:false/identity_unavailable`，后续应用批次与 foundation 未由该命令运行，整条命令失败。[原失败](check-exclusive-failure.log)与[窄诊断](native101-diagnostic/summary.json)保留：五份 native 源码/测试/构建脚本及独立编译二进制与 `12b1a66c` 相同，当前/基点最窄复跑各 3/3，通过不能覆盖原失败。未稳定重现，未排除组合时序或共享环境影响，不能确定机制，也不能认定与原 17 同因；36 和最终验收阻断不解除。之后单独补跑剩余应用批次与 foundation，结果另记，不拼成一次全仓通过。

剩余应用批次原始计数为 2,542 项、2,480 通过、40 失败、3 取消、19 跳过，约 1,306 秒；这是[部分补跑](app-rest-partial.log)。32 文件停滞逾 13 分钟后单独中断；随后计划结束五个持续扫描的自有文件，实际枚举时两个已退出，只向仍在的三个发 INT，合计四个文件中断，见[记录](app-rest-interrupt.json)及[32 记录](app-rest-test32-interrupt.json)。两处 99 测试在批次期间修订，共享提示也在后段修改；该批次不代表最终候选完整覆盖。[失败分组](app-rest-failure-analysis/README.md)区分退役工具依赖、等待/HTTP/脚本预算失败、118 事件数断言与中断；不能把它们一概归为环境或原 17。工具依赖已按上表修订，其他未归因项与未完成范围保留待验。

112 自有进程的 macOS sample/约一秒 CPU profile 定位采样瞬间的 `identityCovers` 同步保护目录扫描，[记录](workflow-diagnostic/README.md)保存源码、调用栈及 inspector 收尾。它不解释全部失败；也没有量化新证据目录的耗时增量。后续开发 25/25 与关键工作流 5/5 不替代原宽批次归因。主代理没有停止观察到的未知归属长时间测试进程。

字符串/动态入口补扫还覆盖 bin、main/dev、产品循环、npm/CI 与 smoke 路径；`.scratch/` 中若干旧 product/pre-workspace bin 探针是历史基点脚本，本轮保留原样，不能用于当前候选复跑。

独立 PTY 证明初版把配置菜单套在 Node watch 内会留下等待源码的监督器，修为配置菜单直接运行；原失败和最终复验均保留。早期 PTY 驱动等待时没有持续排空输出而超时，只是驱动局限，不能据此判源码信号处理失败。

Linux 首轮 CLI/entry 因隔离依赖布局缺 durable/QuickJS 等加载失败；补齐本轮链接后通过，已过 worker/helper 不重复计数。该证据是共享依赖复用与个人最小依赖安装，不是完整 workspace 干净安装；干净安装由 macOS pack 证据承担。制品核实器的路径 realpath 与 ps 解码错误也原样保留，修的是核实器。

升级脚本有意用裸 SQL 保存停止未核实/未知占用形态，结束后按脚本规则保留其临时资料，路径见日志；这不是新发现的真实 OS 停止失败，也不能关闭 36。没有用当前通过解释原 17 的触发原因。

## 待验范围

本单不计完整 A1–A12 通过。真实模型、QQ/Telegram、MCP、调度及各业务完整组合仍按原工单和 39 补证，生产接管由 40 执行。新正式 CLI 的拥有者实际体验与最终候选验收保持待验；自动 PTY 是工程证据。36 原归因、CI 的完整 OS/Node 矩阵与生产服务切换没有被这些结果替代。

本单隔离实施与调用方返工已完成，最终工程验收仍待原生失败及宽批次残项核实。历史 `.scratch/` 探针保留原基点适用范围；本轮没有把它们改成新的验收入口，也未提交或推送。

## 提交材料格式

原始日志、PTY输出和补丁含行尾空白或缺末尾换行，提交前保留原字节到[原文归档](commit-raw-evidence.tar.gz)，同路径文件为规范化展示副本；补丁需要精确重放时读取归档成员。原阶段清单的指纹仍对应归档原字节，不用展示副本冒充原文。

[格式映射](commit-evidence-format.json)逐项记录归档成员的原SHA-256、字节数和展示副本指纹；未列出的原阶段材料未变。此操作不修改源码、测试结论、失败记录或生产状态。
