# 可配置子代理角色联合验收记录

本轮两项主要实现返工、相关夹具修复和独立审查已闭环，双产品真实模型与最终双平台受影响检查通过，05 交 ready-for-human。macOS 基线完整检查及两次 Linux 完整检查的实际失败均保留；最终 v6 没有单次全量绿结论。真实外部 MCP/IM 与拥有者主观体验仍待验，工单不标 resolved。root 汇总主区，requirements_audit 为独立只读审查上下文，linux_acceptance 持有独立 Linux 副本，model_acceptance 持有独立模型验收副本。主区只有 root 写入，没有提交、推送、合并、部署或修改日常实例数据。

## 对象与证据归属

含必要行尾空白的 16 份原始补丁和 5 份失败日志以无损 gzip 保存，避免改写证据来满足仓库格式门；[存储映射](05-raw-storage-map.json)记录原逻辑路径、原始 SHA 与压缩文件 SHA，解压后仍为原字节。旧独立报告、JSON 与已封存归档均未修改，旧记录中的原路径可通过映射找到原件，需原名时先解压。

接手提交为 `5f9da455072d68180ef19fc92ad02070cea583c1`，分支 `Eitrous/subagent-roles`，初始工作区干净；[环境](05-environment.json)与[初始输入](05-inputs.sha256)固定当时对象。[交接核对](05-handoff-input-comparison.json)确认最终 04 清单 40/40、77/77 一致；01–03 被后续修改的旧摘要不继续用作当前证明。旧工单中的 d12eb63 与未提交状态属于历史时刻。

当前交付对象是[第六版输入](05-final-source-inputs-v6.json)与[30 文件完整补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair-v6.patch.gz)。冻结输入共 620 项（619 普通文件、1 符号链接），含全部 Git 跟踪的非 .scratch 文件、本轮新回归、规格和计划；持续更新的工单与证据不参与摘要。[最终独立审查](05-final-independent-review-v6.md)、[65 项输入](05-final-independent-inputs-v6.json)与[原始归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review-v6.tar.gz)覆盖全部 30 项修复，65/65 与主区相同，无未解决实现阻断。完整补丁在主区反向 apply --check 通过。不同副本、版本与批次的通过数不相加为一次全量通过。 [格式核对](05-final-format-check.json)在独立临时 Git index 中覆盖当时全部 215 项改动和新增文件，差异空白与恰一个末尾换行检查均退出 0，未修改用户 index。

| 版本 | 相对前版的变化 | 冻结内容与独立审查 |
| --- | --- | --- |
| v1 | 两项生产修复及相关调用方、夹具、文档，共 25 文件 | [输入](05-final-source-inputs.json)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair.patch.gz)、[审查](05-final-independent-review.md)、[60 项输入](05-final-independent-inputs.json)、[归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review.tar.gz) |
| v2 | 仅 10/125-resource/84 三个测试追加同步，共 27 文件 | [输入](05-final-source-inputs-v2.json)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair-v2.patch.gz)、[审查](05-final-independent-review-v2.md)、[62 项输入](05-final-independent-inputs-v2.json)、[归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review-v2.tar.gz) |
| v3 | 仅 14 单行分页同步，共 28 文件 | [输入](05-final-source-inputs-v3.json)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair-v3.patch.gz)、[审查](05-final-independent-review-v3.md)、[63 项输入](05-final-independent-inputs-v3.json)、[归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review-v3.tar.gz) |
| v4 | 仅 122 有限等待校准及既有测试策略笔记，共 30 文件；第二轮 Linux 完整检查对象 | [输入](05-final-source-inputs-v4.json)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair-v4.patch.gz)、[审查](05-final-independent-review-v4.md)、[65 项输入](05-final-independent-inputs-v4.json)、[归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review-v4.tar.gz) |
| v5 | 仅 runtime.ts 的 try 范围机械整理，生产行为与 v4 等价 | [输入](05-final-source-inputs-v5.json)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-repair-v5.patch.gz)、[审查](05-final-independent-review-v5.md)、[65 项输入](05-final-independent-inputs-v5.json)、[归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-independent-review-v5.tar.gz) |
| v6 | 仅 14 的单条先到夹具隔离，共 30 文件；最终交付对象，生产输入与 v5 相同 | 上述最终输入、补丁与独立 v6 记录；[归档及主区核对](05-final-independent-v6-root-verification.json) |

v5 按仓库规则将验证主体原序提入具名方法，try 各只包一条语句，既有来源比对/赋值移到捕获之后。前轮漏审的范围规范已补正，[机械差异](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-runtime-try-narrowing.patch.gz)及[旧字节](05-runtime-before-try-narrowing.ts)保留。[独立 AST 结果](05-runtime-try-equivalence.json)确认验证语句与 typed catch 顺序相同、其余 249 个 Runtime 成员相同；[独立回归](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-independent-runtime-try-regression.log)八来源边界/等待恢复共 30/30，[原缺记录反例](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-independent-runtime-try-original-probe.log)仍拒绝坏摘要和重放。v4 完整结果不改称 v5/v6 完整结果；runtime 补等价与窄回归，v6 追加 TUI 整文件，不重复付费模型或 native 全组。各版原记录保留，不覆盖改写；[追加归档校验](05-final-supplement-archives-root-verification.json)确认 v4/v5 独立归档和 Linux 失败后增量材料清单一致。

## 发现、修复与反例

| 项目 | 原反例与归属 | 最终行为与证明 |
| --- | --- | --- |
| target 摘要碰撞 | 普通工具对 target.trim() 计摘要却按原路径执行；两个合法目录 foo 与 ` foo ` 同键静默复用，归 04 | 摘要保留原字符串；最窄用例修前红、修后全文件 8/8。非作者真实目录探针第二次得到 request_conflict，两摘要不同，原工作、子任务与目标不变。见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-target-fix.patch.gz)、[修前](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-target-regression-before.log.gz)、[修后](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-target-regression-after.log) |
| 缺来源记录仍自动送达及等待消费 | 完成子任务删除 execution 后，父模型已收到摘要，agent_wait 又从当前配置猜来源并返回结果/报告资格，归 02 | 等待、普通结果/消息装配、发送、响应接受、唤醒与调度收尾共用实际来源核实；只依赖截至目标 Task 的历史和冻结报告，不被未来复用扩大。坏记录保留、不重放、不猜恢复。新增八个真实 Runtime/Driver 正负例，非作者六文件 35/35，原反例修后零坏摘要注入且 source_invalid。见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-source-consumption-initial.patch.gz)及独立归档 |
| 旧来源与身份夹具 | 41 的旧资料引用缺实际摘要；84 把内部非拥有者事件当可委派来源；86 忙任务缺执行/父绑定，固定评审由普通身份伪造 | 使用真实资料版本、授权失败断言及合法 Orchestrator 固定入口；三个忙 Task 继承真实来源和父绑定。最终 messaging/recovery 独立 13/13，受影响 41/84 两例 2/2。首版仅补 scope 虽绿却有 execution_binding_invalid，新增 completed 与模型恰一次断言后先红再修，原假绿日志保留。见[恢复补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-recovery-fixture.patch.gz)、[调用方补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-caller-fixtures.patch.gz) |
| demo 与上下文分类 | 合成会话缺 task.memory_accessed，分类仍断言 15 | 补事件且仍自动编号；分类 16 并明确 subagentRoles 标签/零用量。两文件 12/12，非作者最窄两例 2 红→2 绿。见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-fixture-sync.patch.gz) |
| 真实模型脚本前提与输出矛盾 | 已配置模型不支持 low，启动零请求；改 off 后编码 verify 实际返回 passed+reason，旧 schema 只允许 passed，宿主正确拒绝汇入 | 正式夹具改 off，schema 增加可选 reason:string，仍要求 passed 且拒绝未知字段；实际编译器正负六项断言通过。保留原失败实例，不恢复/重跑其工作；新实例真实完成冻结→独立检查→汇入。见[推理前提补丁](05-model-thinking-fixture.patch)、[输出补丁](05-model-output-fixture.patch) |
| Linux 保护目录夹具 | 10 的父级/兄弟路径断言硬编码真实 /var/lib/ruukoto；三目标实际都因其 service-ops 不可遍历而 EACCES | 只改夹具，在真实自有临时目录创建保护根及兄弟工作目录，保留根/父级拒绝与兄弟允许；生产 fail-closed 不改。macOS 与非作者最窄各 1/1。见[实际诊断](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-linux-protected-path-probe.log)、[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-protected-root-fixture.patch.gz)、[独立审查](05-protected-root-independent-review.md)。首版诊断的 shell 引号错误另保留，不计有效探针 |
| Driver 消费时机夹具 | 125-resource 伪造无 SubAgent/Work 的普通 Task，只 mock injection/Accepted，新增真实 Runtime recheck 正确拒绝，成功分支未发送 | 同一 Driver 接缝显式 mock recheck 并逐次核 session/results/messages；两分支都须实际发送 sentinel 一次，成功后消费 1 次、失败 0 次。作者 1 红→2 绿，非作者 2/2，真实来源八例与生产校验不改。见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-125-parent-injection-fixture.patch.gz)、[红例](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-125-parent-injection-fixture-red.log.gz)、[绿例](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-125-parent-injection-fixture-green.log) |
| 来源停用后旧唤醒期望 | 84 在 QQ 停用后等 queued wake 完成，实际按新来源门 canceled/subagent_source_invalid，原完成子结果保留 | A 改为具体来源拒绝、零新增模型/外发、工作不伪标取消且原子结果保留；B 已登记 pending 后换目标的取消断言不变。作者、非作者 A/B 窄例各 1/1；89 组件原 target_changed skip 保障独立 1/1。见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-84-retarget-fixture.patch.gz)、[原红](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-84-retarget-fixture-red.log)、[活例](05-84-retarget-fixture-live-diagnosis.json)及独立 v2 |
| 冷重连分页缺同步 | 14 的事件流可先恢复完整唯一正文，后续历史页请求稍后才发，原即时 requests.some 抢先失败 | 仅改为等待原同一精确分页条件，默认 15 秒不变，其余完整/唯一/UTF-8/滚动断言不动。作者与非作者同门控均确定旧红/新绿，最终无门控各 1/1；生产不变。见[补丁](05-14-history-fixture.patch)、[机制](05-14-history-fixture-analysis.md)、[确定性红](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-14-history-gated-red.log)、[同门控绿](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-14-history-gated-green.log)及独立 v3 |
| 单条先到夹具与在途冷恢复交错 | 原 14 手工清空再次连接的 flow/tasks，但旧 get_task 或 list_tasks 仍可补入合法拥有者“启动工作”；两种门控均可复现 users=[] 原断言红，未泄露内部输入；仅再等一次 loadHistory 的候选被迟到 list_tasks 反例否定 | 单条先到用未启动、无后台回调的独立 TuiApp/ViewState，经原已认证连接实际 loadEntry；原内部记录必须读入、元数据前后为 0、详情后到及当前投影均不露内部原文。再次连接的实时/重连/逐页/↑/置顶/搜索原断言保留，另防拥有者历史未加载的假绿。独立同门控红→绿、最终两窄例 2/2；主区整文件 35/35，生产不变。见[补丁](05-14-visibility-fixture.patch)、[门控归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-14-visibility-race-evidence.tar.gz)、[非作者诊断](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-14-visibility-independent-diagnostic.tar.gz)、[归档核对](05-14-visibility-archives-root-verification.json)；Linux 第二轮原栈 14:291 确为这条空列表断言，actual 只有合法拥有者占位行，已与门控同因核实；最终 Linux 整文件 35/35，0 跳过，79.183 秒，退出 0 |

GitHub 宿主固定评审独立保留可信 completed confirm 来源、固定定义、只读工具/MCP、禁消息与普通复用、冷恢复和唯一归档；不要求普通 execution，不因 general/reviewer 覆盖而新增 bash。未知异常继续上抛，来源错误保留具体原因，不误称 work_canceled。

## 检查与平台

macOS 为 arm64、Node 24.15.0。原完整 `npm run check` 针对接手基线运行，期间主区只写工单/证据，返工在隔离副本完成；实际退出 1，1535.598 秒。构建及静态通过，独占 worker/原生监督器组 38/38，后续应用组 1556 通过、49 失败、7 跳过、0 取消。原命令未进入 foundation，已另补 9 通过、1 真实模型 gate 跳过。[原日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-full-check.log.gz)、[实际退出](05-full-check-result.json)、[49 项失败](05-full-check-failures.json)与[foundation](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-foundation.log)保留，不能改称该次全量绿。

macOS HTTP 零调用失败有独立最小定位：不 import Ruukoto 的 http.createServer 仍收到 GET /，同步 lsof 明确客户端为 Mirasim，Accept 为 text/html,*/*；工具预期路径在批准前未出现。127.0.0.2 bind 不可用，IPv6 同样被探测。没有改变系统网络配置、产品 HTTP 或严格零请求断言。其他请求计数、空响应、超时、script_cpu_limit 和 PTY 失败按各自事实保留，不能全部归给此探测。最终串行通过也不证明原并发/CPU 问题已修复。

原 49 项的[逐文件覆盖审计](05-original-failure-coverage-audit.json)在最后四文件执行前记录为 41 项有后续分组证据、8 项未核实；随后在最终主区串行执行 15/23/113/121 四个整文件，24/24、0 跳过、97.945 秒，剩余 8 项原断言也通过。至此原失败均可找到后续定向结果，含原因未明的 PTY/来源超时；这证明该批次结果，不倒推原首次失败原因，也不覆盖其失败记录。

| 实际批次 | 对象、结果与界限 | 原证据 |
| --- | --- | --- |
| 首轮主区静态 | `npm run check:static` 退出 0，29.268 秒；覆盖首轮 25 文件生产/测试/模块文档，追加夹具另验 | [静态日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-static-final.log) |
| 三夹具后的主区静态 | `npm run check:static` 退出 0，30.823 秒；覆盖第二版 27 文件与最终三个测试夹具 | [静态日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-static-final-v3.log) |
| v4 主区静态 | `npm run check:static` 退出 0，30.869 秒；覆盖第四版 30 文件及测试策略笔记 | [静态日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-static-final-v4.log) |
| v5 主区检查 | 静态退出 0，37.353 秒；七文件 57/57，0 跳过，29.380 秒；独立八来源边界/等待恢复 30/30 及原缺记录探针通过 | [静态](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-static-final-v5.log)、[回归](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-runtime-try-narrowing-tests.log) |
| 最终 v6 主区检查 | 静态退出 0，29.743 秒；TUI 14 整文件 35/35，0 跳过/取消，Node harness 67.378 秒；非作者同门控红→绿及最终两窄例 2/2 | [静态](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-static-final-v6.log)、[退出](05-static-final-v6-result.json)、[TUI 日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-14-visibility-final-macos.log)、[TUI 退出](05-14-visibility-final-macos-result.json) |
| 最终 macOS native 四文件 | `112-workflow-real-steps`、`125-agent-wait`、`subagent-workspace-snapshot`、`workflow-role-integration` 串行 31/31，0 跳过，393.121 秒，退出 0 | [日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-macos-native-final.log)、[退出](05-macos-native-final-result.json) |
| 最终 macOS 六输入编码 | 正式 `122-workflow-code-acceptance` 1/1，0 跳过，96.341 秒，退出 0；真实冻结成果与组合汇入 | [日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-macos-batch-final.log) |
| 原基线失败定向复核 | `22-auto-review`、`45-github-events`、`58-plan-mode`、`72-on-demand-backend` 串行 47/47；不是完整 check 的替代 | [日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-baseline-followup.log)、[实际构建物](05-isolated-worker-inputs.json) |
| 最终 macOS 余下原失败 | `15-tui-pty`、`23-web-search`、`113-workflow-source-capabilities`、`121-workflow-personal-acceptance` 串行 24/24，0 跳过，退出 0，严格原 HTTP 断言保留 | [日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-macos-remaining-final.log)、[退出](05-macos-remaining-final-result.json) |
| Linux 新接口基线 | ssh tx 唯一 tmpfs 副本，Node 24.21.0、bubblewrap 0.9、user systemd/cgroup v2；八文件 73/73，原 08 全文件 19/19，正式 scope 探针 3/3，均 0 跳过；616 项源码前后匹配 | [报告](05-linux-baseline-report.md)、[原始归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-linux-baseline-evidence.tar.gz) |
| Linux 最终来源消费 | 最终生产补丁与调用方，十二文件 121/121，0 失败/跳过/取消，122.871 秒；恢复另 5/5。121 组 617 项输入前后相同，之后仅已知恢复测试文件改变，生产代码不变 | [报告](05-linux-consumption-report.md)、[原始归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-linux-consumption-evidence.tar.gz) |
| Linux 首轮完整检查 | 正式 `npm run check` 沿首轮冻结输入，默认 3 并发，退出 1，1507.241 秒；构建/静态通过，应用 1658 项中 1640 通过、5 失败、13 跳过、0 取消；foundation 按原脚本短路，另补 9 通过、1 真实模型 gate 跳过，8.586 秒 | [报告](05-linux-full-original-report.md)、[原始归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-linux-full-original-evidence.tar.gz) |
| Linux 第二轮完整检查 | 正式 `npm run check` 沿 v4 冻结输入，默认 3 并发，退出 1，1520.285 秒；应用 1658 项中 1644 通过、1 失败、13 跳过、0 取消，1382.899 秒；唯一原断言 14:291 被迟到的合法拥有者输入打断，与门控竞态匹配，foundation 按原脚本短路。最终 v6 的受影响补验单列 | [最终平台报告](05-linux-final-report.md)、[原始归档](05-linux-final-evidence.tar.gz)、[root 回读](05-linux-final-root-verification.json)、[独立回读](05-linux-final-corrected-independent-audit.json) |
| 最终 Linux v6 补验 | TUI 14 整文件 35/35、79.183 秒；来源八例加等待恢复 22 例共 30/30、24.307 秒，均 0 跳过/取消；完整静态退出 0、133.177 秒，全部顺序执行。620 项前后相同，完整 1552 相对 v4 仅 runtime/14 两项改变，实际 169 个应用测试文件与冻结集合相同 | 上述最终平台报告、归档与双上下文回读 |

Linux 前两轮 SSH 255 是客户端传输中断；原 runner 独立继续，结果来自其实际退出记录，没有重启隐藏失败。首次大上传主动中止且未解包执行、后续小归档核验、npm 提示与夹具假绿都保留。最终完整副本保留所有源码/测试/文档及被扫描文档引用的 .scratch 材料，排除未被引用的历史压缩包；其清单和排除理由单列，不把省略的归档当成被执行输入。空间只通过清理本次可重建 npm 缓存准备，没有清理其他任务或改系统配置。

Linux 原完整检查五项失败中，10、125-resource、84 与 14 的夹具已按上述实际反例同步；122 原 90 秒等待在单跑仍失败（109.045 秒），当时五项验证已完成、实际汇入正在运行、无 Task 错误，不能归为整轮偶发后忽略。随后唯一私有诊断在有限 180 秒内完整通过原全部断言，实际报告等待 110.375 秒、整命令 129.295 秒；正式 90 秒两次红及诊断差异保留在[原始增量](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-linux-post-full-raw.tar.gz)。依据该实测只将正式 122 的报告等待校准到 180 秒并补既有[测试策略笔记](../../../.agents/notes/implemented/testing/2026-10-13-workflow-joint-acceptance.md)，见[补丁](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-code-batch-wait-calibration.patch.gz)；启动等待、全部产品运行时限、行为断言和默认并发保持原契约。[独立校准审计](05-code-batch-calibration-independent-audit.json)亲自机械还原诊断与正式源码，全部原断言未变；第二轮正式完整检查中的 122 原全部断言已通过（用例 174.421 秒）；全轮实际退出 1，唯一失败为 14:291 的夹具竞态，原堆栈只有合法拥有者“启动工作”占位行，与两种有界门控反例一致，没有内部原文。v6 只修该夹具隔离；最终 Linux 整文件、机械 runtime 30 例与静态均通过。两次完整检查实际失败不改称通过。

## 真实模型与平台边界

使用已有配置的 deepseek/deepseek-flash Responses，模型与 worker/工具均真实，原凭据和日常实例不改。正式 125 双产品通过（约 28.4/25.7 秒）；正式 123 修正前提后个人场景通过（20.7 秒），编码场景在兼容输出 schema 的新实例通过（41.2 秒，11 次真实 POST）。个人场景实际访问一次性 app_data 库的真实表/行，是本地业务事实，不是外部 IM 或个人平台调用。

最终自定义 native 场景双产品通过：普通仅 request/key、工作流默认任务正文均实际 bash 写 proof；reviewer 实际读到 staged/unstaged/untracked binary 的当前哈希，绝对路径写源被拒且源字节/index 不变。编码场景还验证编辑 reviewer 后新定义生效、旧对象保持摘要；新 scout V1→V2、旧工作继续 V1；坏 description 和缺 no_such_tool 有可修复诊断，修正后真实执行 bash。最终角色探针个人 3 项、编码 8 项检查通过；personal 16、code 44 是各自实际 send/usage 记录数，不是 60 个测试用例。含保留的诊断过程共 137 次模型 POST、均 HTTP 200，无传输异常；另 2 次非模型 GET 返回 401 单列，HTTP 200 不当作产品断言通过。

[模型报告](05-model-acceptance-report.md)、[安全归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-model-acceptance-evidence.tar.gz)、[执行者校验](05-model-acceptance-archive-check.json)保留 11 个原始实例、JSONL、实际 prompt/工具产物、SQLite 账本与 proof/来源字节。root [回读核实](05-model-root-verification.json)在当时确认 160 项实际生产 TS 与主区相同、压缩包清单 748/748 项哈希一致；此后 v5 只有 runtime.ts 机械移动，另 159 项不变，前后摘要、等价审查与定向回归另列，不改模型原档案。归档共 749 个常规文件，执行者另核对 683 个实例文件与原始路径逐字节一致。按实际配置凭据值两轮扫描零命中，所有认证/模型配置不入包，临时凭据副本已移除。正式 123 与保留档案副本的差异、哈希及原失败均在报告中；后者只加计数/留档/认证清理，验收请求、工作流与断言相同。

[非作者模型证据审计](05-final-model-evidence-audit.json)另逐条核对 137 个完整 prompt 字节/摘要与 selection 状态、请求数和实际 proof；扩展的角色编辑/错误修复五项只在编码产品探针执行，不推广到个人产品。

最终角色探针停止时，个人 main 的一个 ordinary 结果唤醒仍 queued，因此不以该探针宣称所有普通结果均已完成送达；唯一报告和等待/打断由正式 123/125 对应场景证明。真实模型只覆盖本次一个既有模型与 macOS native，不推广到其他模型或 Linux 真实模型。

模型阶段未检查真实外部 MCP/IM 配置；随后在新时间点做[只读前提补查](05-external-prerequisites-readonly.md)，两产品默认及本机约定开发根共 6 个旧档案的 MCP/QQ/Telegram 配置表均 0 行，两轮快照一致。只在私有副本查配置计数，副本已删，不读凭据或业务表、不连接或启动日常实例、不发网络请求。该结论只覆盖已查本机路径，远端/自定义路径及平台可用性未验，不能泛称所有环境缺配置。原模型报告与压缩包保持原字节。

真实外部 MCP/IM 与副作用仍待验，离线 Runtime/mock MCP 证据不冒充远端服务。恢复需选择获准真实服务、只读允许列表/凭据绑定范围和自有测试目标；已查旧库版本 29/32/39/41，当前代码 45，使用匹配版本查阅或独立当前格式测试档案，不直接启动/自动迁移旧库。IM 另需明确测试入口、收件目标及具体发送授权。拥有者主观体验单列，不由模型或配置计数代签。

## R1–R14 对照

各项实现及调用方已由[首轮](05-final-independent-review.md)及[最终独立审查](05-final-independent-review-v6.md)核实；下表把联合运行事实和仍需验收的层次对应回[原规格](../spec.md)，不重复其要求。

| 要求 | 本轮依据 | 判断与界限 |
| --- | --- | --- |
| R1 | 独立共同来源检查、双产品普通/工作流 role integration、真实模型默认两入口 | 实现与双入口运行通过；外部身份效果另验 |
| R2 | 独立 role-library 文件/目录负例，真实新增 scout、坏文件及修正 | 工程与真实模型通过；文件编辑易用性待拥有者 |
| R3 | 双产品真实普通 request/key 与默认工作流均有 bash 调用及 proof 字节 | 通过，不以工具列表或模型自述替代 |
| R4 | 独立角色解析、真实 Driver 正文/模型继承与请求重建 | 通过；未增加模型覆盖、继承或模板功能 |
| R5 | 权限完整策略正负例，双平台 native 源/index/旁路拒写，真实模型源字节不变 | 工程与真实执行通过；没有用 prompt 冒充隔离 |
| R6 | 显式工具/MCP 发现与配置变化正负例，真实缺工具后修正执行 | 工程通过；实际外部 MCP 未验 |
| R7 | 定义/工作流目录钉版、继续/复用/消息/冷恢复回归，真实 V1/V2 旧工作续派 | 通过，角色路径变化不替换已保存对象 |
| R8 | 实际 prompt/JSONL/选择事件重建，资料/记忆/MCP 撤销窄例与新来源消费负例 | 工程通过；外部服务身份及撤销待真实平台 |
| R9 | 双产品无 target bash、独立目录，真实原值摘要冲突反例闭环 | 通过；代码审查另显式 target |
| R10 | 双平台 Git 当前内容/二进制、无源写与仅子增量汇入，真实模型当前哈希 | 通过；忽略依赖不自动复制，缺依赖按实际报告 |
| R11 | Linux 非 Git 占用/让出/审批与父聊天，副本及保护目标的 Git 前置负例 | 通过，不将无 target 业务误限为 Git |
| R12 | 双平台真实冻结→独立验证→汇入；失败/未知效果/零工具 passed 拒绝 | 通过，模型 passed 不能替代账本与冻结绑定 |
| R13 | 真实 SDK 旧 mode 拒绝，旧版本保留/冷恢复/协议拒绝 | 通过，不迁移历史或重放旧工作 |
| R14 | 原缺记录真实反例转拒绝，最终来源消费、等待/唯一报告/停止与共享名额回归 | 本轮实现阻断已关闭；完整检查结果与外部边界单列 |

## 人工交接与恢复条件

拥有者仍需在拟使用实例验收默认 shell 能否完成原调查、角色文件编辑是否顺手、工具/权限/缺依赖错误是否能指导修复、审查是否符合其对当前内容的预期。工程已有实际 bash、当前字节和错误恢复证据；这些是可审查结果，不自动替代主观验收。工作流 [11](../../agent-workflow/issues/11-experience-acceptance.md)仅交叉核实等待/侧栏，不关闭其独立范围。

01–04 笔记 implemented 表示实现落地；本轮 02、04 工程返工恢复 ready-for-human，受影响旧结论由这里的新证据取代。05 的工程返工及受影响复验完成，交拥有者做体验与真实外部环境验收，状态 ready-for-human；真实环境和拥有者结论缺失时不标 resolved。拥有者给出实际服务、允许列表/凭据绑定及自有目标后，验收者只补缺口；IM 另须具体发送授权。后续只复验实质改变或未验证的范围，不重复已固定输入的通过批次。

[最终运行证据终审](05-final-evidence-audit.md)与[小归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F05-final-evidence-audit.tar.gz)追加确认当前交接无未解决的实现阻断，保留其审查时的正文快照和上述全部未验边界。本次唯一 Linux 临时根已在确认本次 runner、metrics、工作目录进程和原生 scope 均无活跃对象后删除；[清理记录](05-linux-cleanup.json)保留绝对路径、有限身份分类与删除后证明，没有停止已识别的其他进程或修改日常实例。
