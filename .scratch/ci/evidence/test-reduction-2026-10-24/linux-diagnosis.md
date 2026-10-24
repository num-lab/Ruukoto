# Linux 诊断与候选验收

本报告区分旧 CI、原版 Linux 诊断、受控反例和冻结候选。冻结候选完整 `npm run check` 自然退出 0，耗时 2459.331s，无超时、人工回收或遗留进程。本轮不包含随后个人令牌原子发布、PTY 阶段同步、模型替身关闭响应连接、清理 stderr 诊断及 macOS 启动标记修复；这些增量另有定向验证，不能拼接成同一版本的完整检查。原版完整诊断包含人工回收失败进程，不作为加速比例的基线。

## 环境与源码

拥有者授权的机器为 `oracle-4c24g`：Ubuntu、Linux `6.17.0-1020-oracle`、aarch64、4 CPU / 24 GB。任务根为 `/tmp/ruukoto-reduce-linux-20261024.G82oCL`，源码位于 `src/`；未修改主工作区、生产实例或全机策略。此前在 `tx` 创建的任务目录未启动测试，切换机器后未再操作。

Node 24.15.0 与 22.19.0 均取官方 Linux arm64 发行包，安装在任务目录。原锁文件经 `npm run setup -- --skip-hooks` 安装，根与 foundation 均已准备；Git、rg、Python/PTY、bubblewrap `--unshare-all`、user systemd `Delegate=yes` scope 已核实。setup 日志已保留，但未精确捕获其完整墙钟时间。

原版为主工作区 `28c033f7` 的完整 `git archive` 快照；远端为 setup 初始化的独立 Git 提交不代表原 HEAD。候选与主实施者冻结版本逐文件核对：848 份代码文件 SHA-256 全部一致，清单及结果为 `ruukoto-candidate-code-manifest.json` 与 `candidate-source-verification.json`。主实施者的候选指纹为 `97d1794bb36645610296ca29cdf1235e30a698ee5a5ac63195f62f10078230ba`。

候选在 Node 24.15.0 上执行 `npm run check`，应用并行度保持 2，`RUN_MODEL_CHECK=0`、`RUN_BACKGROUND_BROWSER_CHECK=0`。候选仅由外部 `/proc` 观察器约每 200ms 记录文件进程，未注入原版诊断轮的定时器栈和 SQLite 采样。观察器提供进程完整寿命的观测范围；起点按内核时钟 tick 量化，不能把观测值当成精确到毫秒的耗时。

## 原版结果

原版 build 通过，完整墙钟 1.962s；static 通过，完整墙钟 209.336s。15、118、122、125、33 五文件按原并行 2 执行，45 通过、0 失败、0 跳过，Node 汇总 183.056s，外部墙钟 183.258s；六输入 122 测试体 124.928s，125 两产品分支 37.175s / 36.876s。原版完整 32-dev 为 25 通过，文件完整进程 76.927s，正常退出。

原版完整应用诊断覆盖全部 294 文件，3196 顶层结果 / 3485 tests，3446 pass、6 fail、33 skip、0 cancelled。Node 汇总 2693.183s，外部墙钟 2694.333s，退出 1，无总期限超时，结束时已跟踪进程为空。原工单的 293 文件计数已过期；294 经原 HEAD、源码目录及 Node argv 核对。

| 失败位置 | 实际证据 |
| --- | --- |
| `19-tui-demo` | 合成会话缺少 `task.mcp_operation_changed` 事件。 |
| `40-desktop-creation` 两项 | `open_workspace/rejected`、`create_session/rejected` 夹具与当前会话结果不一致；其他拒绝和断连分支通过。 |
| `cua-mcp` | 四张上限图片超过测试额外设置的 10 秒期限；生产默认期限仍为 60 秒。 |
| `desktop-personal-settings` | 共享 scenario JSON 写入空窗导致解析失败；`finally` 中 `h.write()` 再次抛错，跳过 `h.close()`。 |
| `personal-tools` | 同进程真实控制客户端发生 `control_response_lost`。 |

desktop settings 失败进程 PID 3583151 的 fd 33 仍监听其自建 `/tmp/rk-settings-WTKzBW/remote.sock`，证据见 `full-app/desktop-personal-hang/`。经主实施者明确授权，核实 PID 与 starttime 后仅向它及 esbuild 子进程发送 TERM，未使用 KILL；其余文件继续完成。这使本轮属于完整发现诊断，不能按其总墙钟计算加速比例。

## 32-dev 退出缺陷

旧 CI `39732364834` 的 commit 为 `419c8384`。Linux Node22 日志将存活 PID 15585 直接关联到 32-dev：SQLite 告警后进入“档案路径”，最后完成“PTY：code首次--config”，取消清理时该测试进程及 esbuild 仍存活。仅凭最后输出不能把 33-config-tui 归为根因。

在原版 32-dev 重载场景中，受控延迟 continue 应答 500ms、继续模型响应 1500ms，等待真实任务进入 running 后退出：Node22 与 Node24 均测试体通过，但文件进程在 20 秒诊断期限结束时仍未退出，最终 exit 124。保留的 80ms、ref=true interval 创建栈为 `TuiApp.tickTiming ← refreshAll ← notify ← submitText`：退出先清掉已有定时器，迟到应答再创建定时器；连接已关闭，任务快照保持 running。

独立副本仅在 `tickTiming` 入口增加退出状态检查，同一反例 Node22 7.381s、Node24 9.290s 完整退出 0。这里的耗时是单个筛选用例的完整进程，不是全部 32-dev。产品修复由关联工单 `03-tui-exit-late-response` 承担；正式回归以 Promise 控制应答顺序，Node22 正式回归 1/1 通过、完整进程 6.135s。Node24 正式回归由最终全量覆盖。

## 122 安全暂停的归因限度

旧 Linux24 的 verify_2 已 failed 且 resultRecorded=true，运行暂停为 write_result_missing，attempts=11，已执行单元 stopVerified=true；verify_3 被中断，verify_4/5 仍排队。这对应写操作后步骤失败或最终输出无效、先记步骤结果再拒绝自动重试的分支，不是尚未记结果时发现工具结果缺失的分支。

旧诊断没有保存 verify_2 子任务状态、输出与工具账本，不能确定历史上游失败恰为何种错误。受控真实 Runtime/worker 用例先由独立 bash 校验者实际写 proof，确认工具 isError=false、resultSummary 完整，再让模型故意输出 not-json；failed/resultRecorded=true、write_result_missing、attempts=1、stopVerified=true 全部通过，测试体 21.185s。该用例证明安全分支与旧快照一致，不证明历史真实原因就是非法 JSON。

## Cua 与 SSH 夹具验收

Cua 保留四张上限图片和超限 follow-up，只移除测试额外设置的 10 秒期限；生产默认 60 秒不变。Node24 受控探针测试体 21.197s 通过，Node22 正式用例测试体 22.056s、完整进程 22.923s，通过且无遗留进程。

SSH 初始候选在 Node22 的五项定向测试中 4 通过、1 失败，失败为恢复在线等待超时；该失败记录保留。子进程启动记录先于真实监听就绪，虚拟时钟也可能先于 reconnectTimer 注册。最终 `forwardOnline` 等待当前 PID 的 READY，再等待已在线或重连定时器确已注册，随后按需推进时钟；首次连接、期限恢复和后续重启均走相同同步。

受控反例对每次转发进程（含首次）注入监听前 200ms 阻塞：旧首次连接未同步的版本 Node22 在“首次在线”失败，完整进程 10.219s；最终候选的期限与退避两项 Node22 6.566s、Node24 5.907s 均 2/2 通过。500ms 退避起点、15 秒读取期限和真实握手断言保留。移除诊断副本中的 200ms 扰动后，与候选 `38-desktop-personal` 字节一致；正式源码不含扰动。

## 冻结候选完整结果

本轮于 `2026-10-24T05:50:39.062125Z` 启动，npm PID 3638436，监督期限 3600s。build、static、应用测试和 foundation 全部通过；完整墙钟 2459.331s（40 分 59 秒），exit_code=0、timeout=false、remaining={}。无强退或中途改源。结束后 848 份代码文件 SHA-256 复核仍全部一致，见 `candidate-check/source-verification-after.json`。

| 测试集 | tests | pass | fail | cancelled | skipped | Node 汇总墙钟 |
| --- | --- | --- | --- | --- | --- | --- |
| 应用 | 3406 | 3375 | 0 | 0 | 31 | 2248.675s |
| foundation | 8 | 7 | 0 | 0 | 1 | 6.613s |

原 294 个应用文件收敛到候选 290 个，runner argv 包含全部 290 个。外部采样捕获 289 个不同应用文件的完整进程，`history-recovery.test.ts` 未被采样命中；该文件在 runner argv 中，且其正文分页、事件去重和换代五条独有通过输出均已保留，见 `history-recovery-observation-gap.json`。因此本轮证明完整发现运行，但没有该文件的独立完整耗时。foundation 6 个不同文件均被捕获，其中连通性文件另有一个同名子进程。进程实例数不能直接当作不同文件数。

| 文件 | 完整进程墙钟观测范围 |
| --- | --- |
| 15 TUI PTY | 78.147–78.368s |
| 32 dev | 79.569–79.787s |
| 33 config TUI | 11.829–12.052s |
| 38 desktop personal | 20.191–20.411s |
| 118 workflow entries | 9.472–9.696s |
| 122 workflow code acceptance | 83.419–83.857s |
| 125 agent wait | 52.501–52.719s |
| personal entry | 71.235–71.471s |

122 四输入测试体为 80.168s；完整进程时间另列于表中。原版六项失败位置在本轮均通过，32-dev 退出后的迟到应答正式回归也随整套通过。foundation 的 1 条跳过为明确关闭的真实模型连通性；离线 skip 不替代外部验收。

## 关联工单 04 定向补验

完整检查自然结束、归档且复核源码后，只同步 `apps/ruukoto/src/personal-control.ts`、`personal-profile.ts`、`test/personal-entry.test.ts`、`personal-cli.test.ts` 四份定稿文件。848 文件复核仅这四份变化，无其他差异；各文件 SHA-256 及变化范围见 `issue04-source-change-scope.json`。这不是在全量执行途中换源，也不把前一整轮说成包含 04 修复。

两版 Node 依次执行 `node --import tsx --test --test-concurrency=2 test/personal-entry.test.ts test/personal-cli.test.ts`，保留离线开关和 600 秒监督期限。

| Node | tests / pass | fail / skip | Node 汇总墙钟 | 完整进程墙钟 | 退出 |
| --- | --- | --- | --- | --- | --- |
| 22.19.0 | 38 / 38 | 0 / 0 | 100.715s | 100.924s | 0，无超时或遗留 |
| 24.15.0 | 38 / 38 | 0 / 0 | 70.876s | 71.153s | 0，无超时或遗留 |

永久回归包含创建临时令牌后、内容尚未写入的受控停点；并覆盖坏旧令牌拒绝、写入/rename 失败保留旧值且释放锁、临时目录/链接拒绝、残留普通临时文件恢复、0600 权限，以及原有真实入口、重启和信号用例。实现审查直接核实旧令牌校验仍先于任何临时写入，临时文件从不用于认证，写入/发布失败在监听开始前沿 `control_start_failed` 释放实例锁。

另在 Node24 从最新入口用例生成独立探针，真实 `apps/ruukoto/bin/ruukoto.mjs serve` 经认证 GET /status 确认 ready 后故意抛 `controlled_ready_bin_body_failure`。测试按预期退出 1，完整 8.499s；这是负向验收，不计为产品测试失败或正常通过样本。真实后台收到 TERM 后 exit 0，模型替身端口 ECONNREFUSED，临时目录消失；七阶段依次为 ready、停止子进程、子进程退出、关闭模型、模型关闭、删除目录、目录已删除。ready 后 102ms 完成清理，观察器无超时或遗留。验证器结果与事件保存于 `issue04-real-bin-cleanup/verified.json`、`events.jsonl`。

这两轮 Linux 定向补验不包含随后增加的 stderr 清理诊断；主工作区已应用该单行补丁，且独立审查在 macOS 用同一 helper 亲自执行多失败探针：原版只见测试体错误，候选同时报告三个清理错误，所有剩余释放继续执行，均按预期退出 1。见[清理独立审查](fixtures/token/cleanup-independent-review/review.md)；不把早先 Linux 结果冒充包含最后这行变化。

## 证据位置与适用范围

原始远端证据位于上述任务根；本地归档为 `/tmp/ruukoto-reduce-linux-evidence/`。原版完整日志为 `full-app/output.log`，进程时间为 `full-app/file-timings.json`；退出缺陷红绿证据为 `dev32-running22/24`、`dev32-guard22/24`；正式 Node22 窄测为 `candidate-node22-tui`、`candidate-node22-cua`；真实写后暂停探针为 `controlled-workflow-cua`；最终 SSH 反例为 `ssh-first-delay-red22`、`ssh-all-delay-green22/24`。冻结版本的完整检查单独保存为 `candidate-check/`；工单 04 补验为 `issue04-node22/24` 与 `issue04-real-bin-cleanup`。

本机为 Linux arm64，不能代替 GitHub x64 的原始 macOS/Linux × Node22/24 四格。真实模型与真实 IM 未执行；离线跳过不记为外部验收通过。原版与候选的 Linux 观察方式不同，且原版含一次授权人工回收，因此本报告不宣称严格 Linux 加速比例。
