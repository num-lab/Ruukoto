# 测试精简实施证据

对应[工单](../../issues/02-reduce-test-suite.md)，实施起点 `28c033f7`，被测内容为基于该提交的工作区快照。最终 macOS arm64 / Node24.15 的完整 `npm run check` 自然退出 0，1125.163 秒（18 分 45 秒）；应用 3387 通过、22 跳过，foundation 7 通过、1 跳过，零失败或取消。源码范围为 `git diff 28c033f7 -- packages apps test verification/foundation/test`，前后 SHA-256 均为 `8025120d17969cff4a012eb4eb30cf0fb1e2234bee548d534004173b33962dd2`，整轮仓库冻结且没有并行诊断。原始结果见 [final.json](final.json)、[完整日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Ffinal.log.gz)及[被测代码差异](final-code.diff)。

Linux 冻结候选完整通过为 2459.331 秒（40 分 59 秒）；后来修改有明确的 Node22/24 定向补验，不能合称同一最终候选的 Linux 全量。独立实现审查无未解决代码阻断；[最终证据审查](final-evidence-review.md)另行核对源码、原日志、计数、耗时与版本适用范围。拥有者已授权提交，尚未推送；同一最终提交的 GitHub 原四格仍待推送授权后验收；主工单保持待环境验收。

## 必要性审查与处置

[旧入口及编号 01–79](legacy.md)、[其他编号/未编号及 foundation](remaining.md)、[Personal/Desktop](personal-desktop.md) 按原文件列出独有作用、承接或退役依据；三个报告是实施输入，以下是实际处置。以 `git ls-tree -r --name-only 28c033f7 test` 发现原应用 294 文件，报告包含每个文件名，无缺项；候选 290 文件。foundation 原 7 文件、候选 6 文件。

| 范围 | 实际结果 |
| --- | --- |
| 旧个人运行 | 删除 51/116/119/121 整文件；112/118/125、role/driver/source/snapshot 的旧产品分支退出，Coding 同体断言保留；123 与 agent-wait-model 只移除默认跳过的旧产品分支，不计离线耗时收益。 |
| 旧 IM/调度 | 按 legacy 表删除 38/40/77/84 正常运行接线，保留旧审批/发送恢复及非 IM 零外发；37 仅删旧调度运行，时间/DST、outbox 和崩溃恢复保留。114/115、work-copy-host-runtime、workspace-snapshot-runtime-boundaries 的旧 IM/调度分支退出。 |
| 其他确定重复 | 71 旧调度启动与重复 bin 进程、74 旧个人面板、76 重复项目查询、33 旧个人内部分支退出；Pi 版本归入 personal-entry，MCP 路由拒绝并入 backend 并取操作列表并集；83 两段无效准备/断言、Demo 算法自身与 URL 副本删除，正式算法的独立参考对照保留。 |
| 命令与审查恢复 | 命令三处同后续流程保留 full_access；十种损坏按三个一致关闭的 SQLite 基线独立恢复。自动审查两种证据损坏共用已关闭基线后各自复制；六种模型→审查→工具结果完整链路继续保留，纯解析入口不能替代流结束及证据接线。 |
| 界面与控制面 | 模型设置 9 条、MCP 7 条、会话设置 16 格使用局部 DesktopBridge 响应；原独有后台持久断言归入既有真实用例。会话两种控制入口均真实覆盖四模式、零任务和幂等，归档→恢复在同一真实夹具完成。 |
| 真执行的准备 | 122 四输入仍先占满三名额再核实第四项排队，保留真实补位、七次尝试、字节/冻结/独立验证/唯一回报/停止；84-integrate 重复状态并入真实成功路径；76 两条纯事务用真实 Db/Store/临时目录；SSH 分类与计时降至原接口/受控时钟，真实 TERM→KILL 保留。 |
| Foundation | 未采用的 06-rpc 探索退出；03 的自定义工具断言并入 05，参数/调用 ID/后续模型收到结果均保留，03 留内置 bash。 |

额外建议中的 skills 设置与剩余会话状态降层没有实施：它们仍保护有效行为，当前未确认可直接删除；额外替身需重建修订、隐藏选中项、保存中及跨实例上下文。已有 renderer 与后台拆分先用实测判断收益，再决定是否值得继续改这些低成本准备。双壳技能选择→导入、真实 SSH、GitHub 现存接线、资料兼容、AppData/OneBot/时间共享库、原生安全和恢复集合均保留。此处不是把“可降层”报告写成已完成。

按实际用例与准备调用点核对，32 条 renderer 场景不再各启动 Runtime；命令损坏的完整原命令准备从 10 次降为 3 次，审查损坏从 2 次降为 1 次，76 的两条迁移去掉 Runtime/控制面，归档正反操作共用一个真实夹具。122 的真实步骤尝试由 11 次降为 7 次；真实 PTY 集合、原生停止与崩溃恢复保留。以上是准备次数变化，不是墙钟收益推算，文件耗时另列。

## 失败归属

旧 CI run `39732364834` 对应 `419c8384`；当前原版是 `28c033f7`，不能互相替代。详见[Linux 诊断](linux-diagnosis.md)。118 查询期间异步最终回报会增加全局序号，现将零事件断言放在同步查询前后，IPC 另验结果。旧 125 超时当前未复现；15 的固定时刻输入错位已用同一 12 秒启动扰动做真实 PTY 红绿，阶段同步保留全部动作、断言与期限；旧 122 的 verify_2 已记录失败，随后按写后不安全重试规则暂停，缺子任务工具账本，无法断言上游究竟何处失败；旧 Linux22 清理时存活 PID 属 32-dev；当前受控实验在 Node22/24 复现退出后迟到应答重启动画的泄漏，单行守门后正常退出，见[关联修复](../../issues/03-tui-exit-late-response.md)。旧日志无句柄栈，不能证明历史那一次必由同一条应答触发。

| 当前原版失败 | 修复和反例 |
| --- | --- |
| Demo 缺 MCP 事件；桌面两条 rejected 夹具已被现行权限允许 | Demo 补齐已有事件；拒绝目录换成不存在路径。原 3 失败、修复后 3 通过；未改生产权限。 |
| personal-tools 审批应答 | 同进程客户端被应答后的同步保护核实阻塞；独立 Node 客户端调用原认证 API 和五秒期限。相同 5.2 秒受控阻塞下原例失败、独立客户端通过，HTTP 1.239 秒；父等待时长不等于 HTTP 时间。 |
| desktop-personal-settings JSON/监听泄漏 | 父子均原子发布、inspect 只读、释放失败仍关闭。原版半写 JSON 失败并遗留监听；只原子发布仍因旧快照覆盖 gate 失败；完整修复通过且关闭一次、无监听。 |
| Cua 四张最大图片 | 移除夹具十秒 override，沿既有产品六十秒。四张各 8MiB 与 48MiB 超限拒绝不变；本机定向通过，Linux 结果单列。 |

[审批诊断](personal-tools-diagnosis.md)与[Linux 夹具诊断](linux-fixture-diagnosis.md)保留受控顺序、退出结果和未验证项；macOS 候选全量另暴露原 native-macos-identity 夹具的就绪文件半写：监督器退出 4、后代继承管道阻止 close；改为原子发布并统一 fork 后早退清理。原五场景 6/6 通过，17 个注入早退均保留原错误码且关闭，见 [macOS 夹具诊断](fixtures/macos/diagnosis.md)。这些修复不降低生产保护，也没有加入自动重试。退出清理的[独立审查](tui-exit-review.md)与 [negative/tui-exit-review.json](negative/tui-exit-review.json)单列产品修复的受控红绿。

## 已完成定向验证

以下均为 macOS arm64 / Node 24.15.0，离线。原日志保存在本次 `/tmp/ruukoto-reduction-*.log`；表中记录完整进程结果，不把测试体累计当墙钟。

| 检查 | 结果 | 完整进程秒 |
| --- | --- | --- |
| SSH 首轮五项定向 | 5/5 | 5.047 |
| SSH 加真实监听同步后的期限/退避 | 2/2 | 2.375 |
| 命令损坏三基线十负例 | 13/13（含父项） | 18.887 |
| 模型/MCP/会话四文件 | 80/80 | 6.299 |
| 122、84-integrate、118 | 19/19 | 76.313 |
| Foundation 03/05 | 2/2 | 1.082 |
| personal-tools 原认证 API | 1/1 | 8.180 |
| 76 两条迁移 | 2/2 | 1.341 |
| 最后 15/83/workflow-role/workspace-snapshot 四文件原并发组合 | 45/45，零失败/跳过 | 116.681 |
| macOS / Node22 原生 helper 完整文件 | 5/5，零失败/跳过 | 4.019 |
| 原生发布修复后的 83/reviewer/快照三文件 | 41/41，零失败/跳过 | 103.592 |
| check:static | 退出 0 | 未独立计时 |

独立审查曾发现 SSH 退避时钟推进早于计时器登记，以及模型 Key 不改目录、无名称/凭据保存的真实覆盖缺失；三项均已修复。Node22 后续暴露的真实监听/重连计时器阶段竞态，已覆盖首次连接、超时恢复和重启，见 [SSH 增量审查](ssh-stage-review.md)。五个有效变异分别覆盖关闭弹窗、MCP 分页、命令停止事实、审查 payload、会话模式：变异时全部退出 1，恢复后全部通过。另一次单独移除 node 校验仍被另一防线拦截，未计为有效负例。命令、源码哈希和原始失败见 [negative](negative/) 中同名 JSON/log；[独立报告](implementation-review.md) 记录审查范围，不代替完整验收。

## 后续发现

完整 macOS 的 97d1794 候选又发现两项：83 的 integrate/call 在目标单元出现前等待超时；personal-entry 跨进程读到正在轮换的空 control.token，失败清理留下 serve 与模型监听。该轮在精确回收 entry 自有进程后自然退出 1，应用3409项、3385通过、2失败、22跳过；总1634.179秒，不能作为通过或性能分母。原日志/元数据见 `macos-candidate-diagnostic.*`。

令牌发布按[04](../../issues/04-publish-personal-token-atomically.md)单独修复：完整临时写入后rename，坏旧令牌仍拒绝；入口清理按依赖逆序且逐项继续。永久回归直接扩展原入口与坏配置用例，受控写入空窗原版确定失败、候选通过；原始证据在 [fixtures/token](fixtures/token/)。主工作区入口整文件7/7通过，坏配置/令牌例1/1通过；入口验证与static同时运行，65.403秒不是性能基线。

83 原目标块与基线逐字相同。六次目标观察及原并发 2 的 83/84 组合未复现；新增失败现场后，后续全量再次失败：子任务已完成、capture/create 已核实停止，父任务却以 `Connection error.` 失败，模型服务器没有收到后续父请求，目标宿主单元尚未启动。受控准备拒绝和 call 前越权别名探针证明了其他失败分支，不能作为本次连接错误的归因。原等待和断言保持。实际模型 SDK 的双请求受控反例已捕获默认空闲期限触发 `socketOnTimeout`、随后复用产生 `ECONNRESET`，同一序列仅将替身响应改为 `Connection: close` 即通过；实施者独立执行的原版/修复断言分别退出 1/0，均约 6.56 秒。真实模型客户端的零重试、期限和 SSE 完整性不变。历史 83 没有记录底层 socket，不能把机制复现当成历史的直接网络取证；详见[连接诊断](model-connection-diagnosis.md)、[连接探针归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Fmodel-connection-diagnostic.tar.gz)和[原工作副本诊断](worktree-call-diagnosis.md)。

## 完整检查与可比性

后续独立排查确认 macOS 可信启动标记的写入窗口存在确定竞态，按[05](../../issues/05-publish-native-marker-atomically.md)单独修复。同一真实 Seatbelt 停点在 Node22/24 旧代码确定失败，原子发布候选通过；坏值、write/rename 故障仍拒绝且不加载 worker，原停止结论不被后来退出观察改写。见[原生标记诊断](native-marker-diagnosis.md)、[方案审查](native-marker-plan-review.md)、[实现审查](native-marker-implementation-review.md)与[原始归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Fnative-marker-diagnostic.tar.gz)。普通 reviewer 额外两组 17/17、101/101 未复现，只作阶段对照，见[诊断](reviewer-diagnosis.md)与[归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Freviewer-diagnostic.tar.gz)。这项已确认发布竞态不能冒称历史 reviewer 的唯一原因。

整个仓库冻结的 `9e2b219` 候选在 1220.651 秒自然退出 1，前后源码指纹一致；应用 3409 项、3386 通过、1 失败、22 跳过，未进入 foundation。15 和 83 均通过，唯一失败为普通 reviewer 委派后等待子任务 completed 超时，尚未进入该例的工作流部分；原等待只检查成功状态，清理前没有输出子任务错误；现补失败终态早报与清理前任务/工具诊断，原成功条件和 60 秒期限保持。历史上游仍未唯一归因。原日志和元数据为 `macos-reviewer-diagnostic.*`。

`12ae6e2` 诊断轮 1627.057 秒退出 1，应用 3409 项、3381 通过、6 失败、22 跳过；独占 69/69，未进入 foundation。15 PTY 和 83 连接错误发生在前半轮。末尾整理证据时误跟随 `node_modules` 符号链接、随后清理复制目录，与四项安全扫描失败重叠；其中一例明确报该误复制路径的 `lstat ENOENT`，其余三项没有独立归因。误复制文件已清理，整轮只作失败诊断，不作通过或性能样本。日志和元数据为 `macos-connection-pty-diagnostic.*`；后续全量期间整个仓库冻结，诊断仅落仓库外。

包含退出修复前的一轮候选检查在 211.708 秒主动中止，退出 1、观测子进程均已退出。第二轮因上述原生夹具挂住，精确清理其后代后报告原退出码 4；独占批次 69 项、67 通过、2 失败（含父项），总 559.803 秒。两轮均不计通过或性能基线；压缩原日志与元数据为 `macos-interrupted.*` 和 `macos-native-hang.*`。

原 macOS `npm run check`：1510.395 秒，退出 1；应用 3488 测试，3460 通过、4 失败、24 跳过。独占批次 40.716 秒、普通批次 1421.522 秒；build/static 通过，foundation 因应用失败未进入。沿用既有安装，setup 未计时，不能称为完整绿色基线。最终候选在同一 macOS / Node24.15、并发与依赖下完整通过 1125.163 秒；应用入口到 foundation 入口为 1075.592 秒，独占 39.506 秒、普通 1035.846 秒，foundation Node 汇总 2.480 秒。build 入口至 static 入口 1.566 秒，static 入口至 test 入口 44.855 秒，原始阶段时间见 final.json。原版失败且未进入 foundation，不计算严格的完整绿色基线加速比例。

原 Linux 应用诊断：2694.330 秒，退出 1，3485 测试、3446 通过、6 失败、33 跳过。因一个失败夹具遗留监听，保存现场后回收了身份已确认的本次子进程；诊断同时采集句柄栈和数据库，不能作为完整通过或严格加速分母。冻结候选 `97d1794bb36645610296ca29cdf1235e30a698ee5a5ac63195f62f10078230ba` 使用原并发完整 check，2459.331 秒自然退出 0，无人工回收或遗留进程：应用 3406 项、3375 通过、31 跳过；foundation 8 项、7 通过、1 跳过，均零失败。外部 200ms 采样捕获 289 个应用文件，另一个 history-recovery 的 runner 参数和五条独有通过输出齐全，但没有独立耗时。该轮早于令牌、PTY 阶段同步、模型替身关闭响应连接及清理 stderr 诊断修复；随后仅同步令牌修复的四个文件，Node22/24 的入口与 CLI 各 38/38 通过。完整报告见[Linux 诊断](linux-diagnosis.md)，原始资料见 [Linux 归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Flinux-complete-evidence.tar.gz)，SHA-256 为 `248406040d055e430e7e43c823c0e3260e8b97de686d2f28588d87dba4a7c789`。不同采样开销明确保留，不计算严格加速比例。后续最终文件的 Node22 PTY 4/4、Node22/24 指定 83 各 1/1 和 Node24 延迟 SSE 均通过且无遗留，见 [Linux 增量](linux-final-fixtures.md)及[原始包](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Flinux-final-fixtures.tar.gz)；PTY 原红、首版失败与第二版绿的独立证据见[诊断](pty-stage-diagnosis.md)、[审查](pty-stage-review.md)及[原始包](../../../git-history-cleanup/archive.md?path=.scratch%2Fci%2Fevidence%2Ftest-reduction-2026-10-24%2Fpty-stage-diagnostic.tar.gz)。

代码差异共有 57 个文件，新增 796 行、删除 3580 行，净减少 2784 行；这是包括局部产品修复的代码范围，不含工单与原始证据。

本地/隔离 Linux 不替代 GitHub macOS/Linux × Node 22.19/24.15 原四格。未推送；最终同一提交四格、每格进入 foundation 并正常退出且低于 45 分钟仍待远端验收。真实模型与 IM 不在本次离线检查中。
