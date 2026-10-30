# 完全访问与通用定时任务验收

2026-10-12。完全访问与关联的通用定时任务实现、文档、决策记录和联验完成。测试使用临时档案、虚拟凭据与模型／IM／服务替身；真实 OS 执行证据另列，不把替身结果算作真实平台验收。没有修改真实账户、凭据、生产数据或部署。证据入库时仅清除日志行尾空白并统一文件末尾换行，命令输出的诊断内容与结果保持原样。

## 最终检查

| 实际命令 | 结果 | 原始证据 |
| --- | --- | --- |
| `npm run test:app` | 1154 通过、1 跳过、0 失败；102.14 秒 | [application-tests-final.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fapplication-tests-final.log) |
| `npm run test:foundation` | 9 通过、1 跳过、0 失败 | [foundation-tests.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Ffoundation-tests.log) |
| `npm run check:static` | lint、各包 typecheck、笔记与文档门禁通过 | [static-check-final.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fstatic-check-final.log) |
| `npm run build` | 原生监督器、worker 与 workspace 产品构建通过 | [build-final.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fbuild-final.log) |
| `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` | 零悬空锚点；14 条无代码锚点的笔记是软报告 | [note-anchors-final.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fnote-anchors-final.log) |
| `git diff --check` | 通过 | 工单交付前执行，无错误输出 |

两个跳过项均为默认关闭的真实模型连通检查。最终应用检查在构建与诊断结束后单独执行，未经自动重试；最终日志才是整套通过证据。

## 平台与执行边界

| 范围 | 真实执行结果 | 证据 |
| --- | --- | --- |
| macOS 当前账户 | 两产品 full_access 的 UID/GID 与后台一致，环境继承、外部虚拟文件读写、本机 HTTP、命令组及后代停止通过；worker 崩溃保持停止未核实与占用；受限 native 拒绝外部文件与网络 | [macos-current-account.txt](macos-current-account.txt) |
| tx Linux 当前账户 | 同上，使用已有 bubblewrap 与 user systemd scope 作受限对照；临时检出已清理 | [linux-current-account.txt](linux-current-account.txt)、[linux-execution-tests.txt](linux-execution-tests.txt) |
| 执行与停止回归 | `test/100-worker-stop.test.ts` 与 `test/101-native-execution.test.ts` 两平台各 36/36 | [execution-tests.txt](execution-tests.txt)、[linux-execution-tests.txt](linux-execution-tests.txt) |
| 容器受限对照 | Docker worker 镜像实际构建成功；`npx tsx verification/smoke/smoke-04-desktop-execution.mts` 6/6 | [build-worker-image-direct.txt](build-worker-image-direct.txt)、[smoke-04.txt](smoke-04.txt) |

复跑入口、平台前置、命令及完整边界见[执行验收](execution-summary.md)。网络证据是本机 HTTP；代理、SSH agent 和工具凭据使用虚拟环境断言，不声明验证了真实代理、SSH 服务或公网业务。

## 行为覆盖

| 完成条件 | 回归与证据 |
| --- | --- |
| 真实任务授权、所有保留工具免审批、受限模式不放宽、执行前拒绝与未知效果不重放 | 授权与工具回归 [125/125](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fauthorization-regression.log)，核心授权 [60/60](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Ffinal-core-authorization.log)；最终应用检查包含结构化文件、HTTP、MCP、应用数据、一次通知、服务及 Plan |
| 委派、继续、复用、协作消息、结果唤醒与工作副本沿实际来源保存模式；旧批准与长期授权不继承 | 权限传播回归 [86/86](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fpropagation-tests.log)，最终应用检查包含委派、worktree、汇总、迟到和重启恢复 |
| 拥有者私聊默认模式与既有任务分开；恢复不重算原模式／模型，终态不激活，目标换代不阻塞主聊天 | IM 恢复 [20/20](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fim-media-recovery-regression.log)，目标换代的[独立复现与修复核实](im-target-recovery-diagnostic.txt) |
| 通用计划保存创建模式与固定目标；每次独立上下文，整项工作完成才唯一回报；重叠、取消、恢复与未知占用 | [调度生命周期 9/9](../git-history-cleanup/archive.md?path=.scratch%2Fgeneric-scheduler%2Fruntime-lifecycle-tests.log)，真实 Runtime／SQLite／JSONL／outbox 集成；主聊天与跨平台回报 [8/8](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fqq-private-tests.log) |
| 定时来源受限审批、固定入口与跨入口拒绝；无 IM、离线、失败与未知发送可查 | [IM 审批 22/22](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fim-approval-tests.log)，最终应用检查覆盖调度审批、公共 outbox、目标换代与单次认领 |
| 完全访问服务未知效果仍使同目标长期授权失效；取消自身计划不与当前工具互等 | [独立审查回归 6/6](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Findependent-review-regression.log)，调度生命周期日志包含自取消与停止未核实 |
| 通知源撤回仍阻止授权和发送；受限服务新操作必须重新审批；非法父身份零委派 | 群结果通知 [4/4](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fchat-result-flow-tests.log)，服务修订与新操作 [1/1](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fservice-revision-reapproval-tests.log)，父身份 [1/1](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fsubagent-parent-identity-regression.log) |

`news`、定时固定 `notify`、旧专用执行 launcher／脚本／变量及授权摘要兼容分支退役；普通搜索 `topic=news`、一次外发和独立实例导入保留。核心 schema 为 35，控制面协议为 19；不同版本库及旧格式导入预览明确拒绝，不提供授权回填。当前模块、使用与部署说明已核对；`docs/visual/` 保留冻结快照，历史验收与归档笔记继续保留其历史事实。

## 中间失败与诊断

[application-tests.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fapplication-tests.log) 是初次应用检查，包含旧夹具与 IM 媒体恢复失败；对应原因已修正，不计为最终通过。[application-tests-second.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fapplication-tests-second.log) 是第二次检查，1150 通过、4 失败、1 跳过：两项旧诊断断言已改为当前文案或带 code 的错误判别，并补新操作重新审批与零委派断言；另两项 macOS 监督器返回 `identity_unavailable`，保守停止语义未放宽。

macOS helper 的独立回归 [5/5](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Fmacos-helper-isolated.log) 与 [90 次并发探针](macos-helper-concurrency-diagnostic.json) 均通过，未复现该次身份失败，不能归因于构建或并发。生产监督器没有因此修改；无法核实身份仍返回 false 并保留占用。最终单独应用检查中两项均通过。Docker 初次代理失败与其他施工中间记录的性质见[执行验收](execution-summary.md)；三个 `*-tests-excerpt.log` 明确是已完成工具输出摘录，不是原始重定向日志。

## 未验收与风险

未运行真实模型、真实 QQ／Telegram 推送、真实代理／SSH 业务或新账户配置下的 root 服务 helper 部署验收。服务工具使用可控 helper 替身验证策略、修订、批准／任务授权、单次认领、取消及未知效果；既有服务部署历史记录不替代本次部署验收。

完全访问可以读取该启动账户有权限的后台数据、凭据与控制面令牌；接口身份校验不是同账户文件隔离。旧库不会自动升级，保留原档案并用匹配代码查阅。停止只核实可归属的命令组与 worker 原组，主动脱离、另行提权的进程及外部服务不保证回收；未知结论保留占用，取消与模式切换不撤销已经发生的外部效果。


## 冻结文档纠正

交付后用户指出 `docs/visual/` 已冻结。该约定在 `README.md:103` 与 `docs/visual/index.html:11` 明示；已撤回本次全部 11 个 HTML 文件修改，逐文件与 HEAD 核对，目录无差异。工单与笔记不再把该目录列为当前文档同步范围。原应用／平台日志记录其运行时的工作树；本次仅恢复冻结文档与修正记录，运行代码未变，不重跑应用或真实执行。纠正后的 `npm run check:docs` 与 `npm run verify-notes` 均通过，输出见 [frozen-visual-doc-checks.log](../git-history-cleanup/archive.md?path=.scratch%2Ffull-access%2Ffrozen-visual-doc-checks.log)；`git diff --exit-code -- docs/visual` 与 `git diff --check` 均退出 0。
