# 工单 29 Linux 验证

2026-10-18（东京时间），通过 `ssh tx` 在专属目录 `/tmp/ruukoto-tools-29.6uZBBr` 验证。真实环境为 Linux 6.8.0-117、Node 24.21.0、uid 1003、bubblewrap 0.9.0、running systemd user manager；模型为 HTTP/SSE 替身，外部服务为专属回环 HTTP。没有使用真实模型、真实 IM、生产凭据或生产档案，没有安装依赖或修改已有检出。

四个真实 OS 组合场景通过，最终 IO/Search/FIFO 叶测 28/28，通过且无跳过。两组证明的范围不同，不累计成完整产品验收。原始组合输出见 [run.log](run.log)，完整结果及替身实际请求见 [summary.json](summary.json)，环境见 [environment.json](environment.json)。

| 场景 | 已验证结果 |
| --- | --- |
| files | durable 子工作读取允许目录的二进制，原字节及 SHA-256 与产物一致；保护档案在接纳前拒绝；目录外读取保存待审批但不开始，拒绝后没有产物。 |
| http-crash | 服务写入后 SIGKILL owner；重开原档案保持原 `pi.tool` 身份，HTTP 外调总计仍为 1；同来源不能再委派，子身份占用保持，独立主聊天继续；只有效果核实仍不释放，独立确认原请求结束后才释放并复用同一子身份。 |
| restricted-confirm | 同时装配通用工具与命令，原 confirm 工作经真实 bwrap/scope 执行；目录外读、写和回环网络均拒绝，命令正常退出，原 scope 已停止。 |
| restricted-auto-review | 原 auto-review 工作使用同一受限命令装配，得到相同文件与网络拒绝；回环服务没有收到命令网络请求。 |

HTTP 恢复中的下一次子模型调用因未知来源被宿主拦截，原子会话未产生完整回答；双事实核实后，原 Work 诚实终结为 `failed`，原因是“子会话未完成回答”，没有把外部写入成功解释成工作成功。核实前的占用、原效果证据、原请求结束证据、失败终态及后续身份复用均保留在归档。

## 源码与依赖

四场景实际执行的 47 项仓库源文件、测试模型帮助程序及 worker 由 [source-four-scenarios-manifest.json](source-four-scenarios-manifest.json)、[源码归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F29-linux%2Fsource-four-scenarios.tar.gz)及 [linux-tools-probe.mjs](linux-tools-probe.mjs) 固定；远端运行后逐文件核对通过，见 [source-verification.json](source-verification.json)。Pi 1.3.0、typebox 及 MCP SDK 保留原 ESM 包，只有仓库源码打包；每个原模块的 `import.meta.url` 保留其远端原目录语义。

四场景后只增加 `approved-ops.ts` 的异常失败分类修复：在截短前登记写入已开始，截短产生效果后抛错必须保持未知。实际差异见 [source-final-delta.diff.gz](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F29-linux%2Fsource-final-delta.diff.gz)。正常文件、HTTP、原命令与隔离路径未改，因此保留四场景原证据；新增失败分支在 Linux 单独复验，最终 IO 15、Search 10、FIFO 3 共 28 项全通过，见 [最终叶测日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F29-linux%2Fleaf-linux-final-tests.log)、[叶测源码](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F29-linux%2Fleaf-tests.tar.gz)及 [叶测 bundle 摘要](leaf-source-manifest.json)。先前的 27 项日志保留，不重复累计。

最新 47 项文件由 [source-final-manifest.json](source-final-manifest.json)与 [最终源码归档](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F29-linux%2Fsource-final.tar.gz) 固定；[远端增量核验](final-source-verification.json)及 [当前根检出复核](source-comparison.json)均确认字节相符。没有声称四场景原 bundle 执行过后来新增的异常分支。

宿主依赖复用工单 26 的 108 包闭包，另外复制当前 MCP 2.0 的 13 包闭包，均没有安装或改写 SDK；两组 package.json SHA-256 逐项核对。精确包清单见 [基础闭包](base-runtime-dependencies.json)与 [MCP 闭包](mcp-runtime-dependencies.json)。磁盘约剩 660 MiB 时开始，避免重新 setup；这不证明完整 Linux 安装或构建成功。构造与运行入口见 [build-probe.mjs](build-probe.mjs)、[probe-entry.mjs](probe-entry.mjs)及 [finalize.py](finalize.py)。

## 失败轮次与清理

前两次探针失败均保留：[第一轮](run-attempt1.log)把事务 draft 带出提交后读取，夹具触发 settled overlay；改为提交内复制后继续。[第二轮](run-attempt2.log)错误要求恢复后的原 Work 为 completed，实际宿主正确拦住未知来源的后续模型，原 Work 在核实后失败终结；修正夹具只接受该明确失败原因，并继续证明占用释放与身份复用。没有将这两轮记作产品失败或额外通过。

[records.tar.gz](records.tar.gz)保留最终四场景、两个失败轮次、原 SQLite、产物、命令回执、输入与实际替身模型请求；[artifact-manifest.json](artifact-manifest.json)登记其中 115 份文件，已从归档逐项核对长度与 SHA-256，见 [归档核验](archive-verification.json)。

两个本轮 scope 均为 not-found，ControlGroup 为空，原临时目录消失，匹配本轮路径的 Node 进程为零，见 [cleanup.json](cleanup.json)。下载并核对归档后只删除本次创建的专属目录，删除后再次核对原 scope，见 [remote-cleanup.json](remote-cleanup.json)；他人的历史目录与 `/tmp/ruukoto-29-io-leaf-test.mjs` 未改。

未验证真实模型、真实 Tavily/MCP 服务、真实 IM、操作者体验、Linux 全量 setup/build/应用测试或生产切换。自动审查模型裁决与其他权限组合沿主工单的独立离线材料，不把本页的命令隔离对照解释为完整三模式验收。
