# Linux 隔离验收

日期为 2026-10-26（Asia/Tokyo）；日志使用 UTC。审查角色在 `ssh tx` 的新目录 `/tmp/code-scheduled-20261026.dA8zm58J` 执行，本目录只保存文本证据，不包含档案、凭据、依赖或构建二进制。

## 被验内容与环境

基于主检出 HEAD `493b91c4` 及当时全部未提交源码建立快照；UTC 15:38:31 打包的归档 SHA-256 为 `7200c2793cec9e1de027a61cee035a0004ede671484dc2f8011add2da563dd5c`，远端逐一核实 1884 个源码文件摘要。归档只含 packages、apps、test、scripts、deploy、foundation 与入口元数据，排除所有 node_modules、dist、worker、.scratch、.git、环境文件和符号链接。

主代理随后修复来源与未知效果恢复，按文件补传两次：UTC 15:42:21 的六文件归档 SHA-256 为 `2f1a4312cf11e015d9d78db62870e95f6c3f076f956879f39b9bcc77815e9b5a`；UTC 15:45:15 的三文件归档 SHA-256 为 `5d17701e1348323b6e5a6a466fdf89fbb9290051ae0dfa7ed603c1f0e43959cd`。第二次增量的关键源码、测试和探针摘要见 [source-manifest.json](source-manifest.json)，后续改动须另判证据失效范围。

后端冻结后，UTC 16:03:54 再补六文件，归档 SHA-256 为 `43e742b80920c88fb3e3a2c35621f83bd7e63355ee053b0c554409b959baebf1`；覆盖来源失效、独立子工作取消、未知效果待报告关闭及真实 Git 工作副本宿主归属。冻结内容摘要见 [frozen-source-manifest.json](frozen-source-manifest.json)，前两轮日志与摘要保留为对应旧内容的证据；最终调度结论采用冻结轮。

环境为 Linux x86_64、kernel 6.8.0-117-generic、Node 24.21.0、npm 11.19.0、bubblewrap 0.9.0、ripgrep 14.1.0、cgroup v2，user manager 为 running，见 [environment.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fenvironment.log)。Node 满足最低版本，但不是 CI 固定的 24.15.0。依赖只读复用既有临时验收目录 `/tmp/ruukoto-config-stage6.6ojMkl`，为本轮源码建立独立 workspace 链接，没有运行 npm install 或修改依赖供体；供体锁文件摘要单独记录。

所有测试使用新临时档案、loopback 模型替身及 `RUN_MODEL_CHECK=0`；运行环境只保留路径、系统用户和 user bus 所需变量，不继承产品目录、API key 或模型凭据。没有启动或停止日常产品后台，没有读取或复制旧 settings、会话或授权。

## 执行与结果

| 内容 | 结果与证据 |
| --- | --- |
| Linux 构建 | `npm run build:native`、`build:worker`、`build:script` 均退出 0；[native](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fbuild-native.log)、[worker](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fbuild-worker.log)、[script](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fbuild-script.log)。Linux native 构建入口无 macOS 监督器编译，Linux 执行代码由实际测试覆盖 |
| 首次源码快照 | [targeted.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Ftargeted.log) 保留未知效果恢复的 `schedule_source_invalid` 旧失败；该内容已由后续两次增量取代，不计为最终通过 |
| 第一次增量后的调度 | 三文件 26 条通过，见 [scheduled-final.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fscheduled-final.log)，证明六文件修复后的行为；第二增量的对应证据在下一行 |
| 第二次增量后的调度 | `test/code-scheduler-core.test.ts`、`test/code-scheduler.test.ts`、`test/code-scheduled-sources.test.ts` 共 27 条通过、零跳过，见 [scheduled-final-2.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fscheduled-final-2.log)；后续受影响内容由冻结轮取代 |
| 冻结调度 core/runtime/sources | 同三文件共 31 条通过、零跳过，见 [scheduled-frozen.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fscheduled-frozen.log)，包括来源失效、取消子工作、未知待报告恢复及真实 Git 宿主任务归属 |
| 平台与普通产品回归 | `test/background-processes-core.test.ts`、`test/background-processes.test.ts`、`test/background-processes-recovery.test.ts`、`test/native-linux-identity.test.ts`、`test/101-native-linux-scope.test.ts`、`test/71-product-entry.test.ts` 共 63 条通过、零跳过，见 [platform-final.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fplatform-final.log)。此轮只对应第一次增量；后续调度来源、恢复与收尾改动采用冻结调度及真实取消探针的对应证据 |
| Scheduled 真实 Linux 后台取消 | 三轮探针均通过，冻结结果见 [scheduled-process-stop-frozen.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fscheduled-process-stop-frozen.log)，前轮见 [scheduled-process-stop-2.log](../../../git-history-cleanup/archive.md?path=.scratch%2Fcode-scheduled%2Fevidence%2Flinux-2026-10-26%2Fscheduled-process-stop-2.log)；探针源码为 [scheduled-process-stop.mts](scheduled-process-stop.mts)，执行时位于远端源码根的 `code-scheduled-stop-linux.mts` |

最终调度测试覆盖真实工作区写入和固定配置、漏期合并、接纳失败零模型调用、问答快照及取消后迟到回答、失效目录、同主会话续接不递归唤醒、重启保留 queued 原键并显式恢复、未知效果的停止与版本确认。平台回归覆盖真实 HTTP 后台跨轮、目录占用、宿主强杀后冷恢复核实且命令零重放，以及 Linux 单元身份、派发失败及停止竞态。

独立 Scheduled 探针经真实 Runtime 到期接纳，再由模型替身调用 `process_start` 启动临时工作区内的真实 HTTP 服务。首次 Task 完成时，运行仍未关闭、后台来源为 `coding-schedule`、HTTP 可访问；取消计划后，后台为 stopped 且 stopVerified=true、占用为零、整项为 canceled、HTTP 不可访问，工作区已有结果文件保留。探针正常收尾停止测试 Runtime，未保留活动服务。

## 未覆盖

本轮没有真实模型、IM、桌面 GUI、机器休眠或系统唤醒证据；没有运行全量 check、全套 Linux 原生边界探针或 CI Node 24.15.0 矩阵。离线模型替身和真实 Linux 进程证据不能替代这些验收，也不代表产品体验已验收。
