# Linux 完全访问命令验证

在 tx 的 Linux 6.8.0-117 x64、Node 24.21.0、bubblewrap 0.9.0、running user manager 与 cgroup v2 上完成六个唯一真实场景。只使用远端 `/tmp/ruukoto-full-26.R7idsd` 专属目录、临时档案、合成环境变量和本机回环 HTTP；模型为 MockModelServer，但 SDK/provider HTTP/SSE、durable 调度、Node/Bash、scope、bwrap 和停止均为真实调用。没有修改根工作区、安装依赖、接触真实模型/IM/生产档案或部署。

所有完全访问场景先通过 `PersonalPermissionsDoc.mode = full_access` 再委派，原工作接纳与 LaunchSpec 的实际模式均有断言；没有伪造准备输入的权限。最终正常增量的实际 SDK 请求保存在 `evidence-final-section/normal/permission-request.json`，system 含“当前工作命令权限：完全访问。”；完整调用正文与工具 schema 同时保存在各 result 的 modelCalls 中。

- normal：UID 1003、原 HOME、宿主 PATH 增量和 48 字符合成用户环境继承，四个内部控制环境键均不可见；目录外文件读取与写入、一次回环 HTTP 成功；7003 原始 stdout 字节和二进制 stderr 完整分页，退出 37 保存运行返回回执；脱离原进程组的 setsid 后代心跳在原 scope 收尾后冻结。用户环境的合成值没有进入 prepared 或私有 request 文件。
- no-receipt-crash：原命令写一行 count 后 SIGKILL owner，恢复保持 unknown 与工作占用，原命令不重发，主聊天可继续；人工效果证据及原引用停止后释放。
- receipt-before-observation：宿主回执发布后、durable observation commit 前 SIGKILL owner；恢复原 returned/37、双流与停止事实，无新命令执行。
- stop-unverified：真实停止后临时隔离原 native claim；恢复及独立重核保持停止未核实，不创建 stop-first 替代认领，人工效果说明不能释放工作；rename 恢复原证据后才严格证明退出并释放。
- cancel-full：实际执行与 setsid 心跳开始后取消原工作；停止已证明而效果未知时继续占用，主聊天可继续；人工核实原 count 与心跳冻结后原工作 aborted，子 Agent 可复用，count 仍仅一行。
- restricted：由原工作 confirm 权限进入真实 bwrap；目录外读取、写入及回环网络均拒绝，合成用户环境不可见，回环服务没有收到请求；与完全访问对照使用同一生产执行装配。

另外，以冻结提交 `89b37f3` 的 33 个生产源码构建独立旧程序，打开新完全访问档案的副本，明确返回 `command_record_invalid` 且模型请求为零。原新档案的 personal.sqlite 前后字节一致；只让旧程序持锁/读取副本，没有将旧程序运行在新原档案上。结果见各正常场景中的 old-refusal.json，冻结源码逐项核对见 old-source-comparison.json。

`summary.json` 汇总六个唯一场景，正常项取最后冻结版；其余五项取 evidence-six-scenarios。该轮结束时汇总器把新增 cancel/restricted 误当恢复场景，虽六项实际断言及清理均已完成，仍在汇总时 ENOENT；原失败保存在 run-six-scenarios-summary-failure.log/failure.json，summary-recovered.json 只从各自已完成的 result 文件重新生成清单。没有把重叠正常增量重复累计为新用例。

其他原失败全部保留：首个启动发生在依赖传输完成前，未进入模型或命令，ERR_MODULE_NOT_FOUND 见 run-transfer-incomplete.log；旧程序反证的首个档案副本因 fs.cpSync 目录权限变为 0775，正确先拒绝 profile_unrecognized，修正副本目录权限后重新验证模式拒绝，材料在 evidence-old-refusal-fixture-failure。未见产品执行或恢复失败。

最新 34 个实际导入生产源/worker 与根工作区字节一致，远端副本与 bundle 哈希一致，108 个运行包的 package.json 与 25 片闭包一致；512 份归档证据长度/哈希已从 records.tar.gz 逐项复核。source-six-scenarios.tar.gz 保存六场景快照，six-to-final.diff 明示它与最终版只有 native 缺前置诊断、权限 section 失败提示/取消传播及单文件同步准备体函数提取差异（最后一项另见 prepare-extraction.diff）；执行、停止、回执与恢复形态未变，最后正常增量使用完整最终版。

全部 16 个本轮自有 scope（含保留失败及重复正常增量）再次核对 not-found/ControlGroup 为空；原临时目录、fixture 和匹配进程均为零。最后一次清理已删除远端专属目录与归档，remote-artifact-cleanup.json 另记删除后的 scope 核对。

records.tar.gz 保存全部实际证据、原 SQLite/私有回执/双流/native 认领、各轮源码快照及失败日志；source-files-tested.tar.gz 保存最终 34 源文件、双探针和构造/核对脚本，不含 node_modules。完整可复现宿主依赖包 source-with-runtime-final.tar.gz（约 23 MB）只留本机 `/tmp/ruukoto-full-26-linux.9wDa5g/source-with-runtime-final.tar.gz`，不必入库。source-comparison.json、artifact-verification.json、runtime-comparison.json、old-source-comparison.json 及 archive-manifest.json 提供逐项核对。

未跑 Linux 全量构建或全量应用测试，未验真实模型/IM、MCP、拥有者体验或部署切换。完全访问同账户可以修改后台证据，测试不提供对抗性隔离保证；scope 停止不承诺主动迁出原单元、另行提权或外部服务的回收。

最后一次增量仅将 personal-command-execution.ts 原同步准备体提为 prepareFullAccess，public try 只调用该函数，校验、返回与错误包装逐句保留；source-before-prepare-extraction.tar.gz 与 prepare-extraction.diff 固定前后内容。原六场景历史保留，使用最终 34 源文件只重跑正常 full 窄场景，目录外读取/写入、权限 section、环境、网络、回执和 setsid 停止断言再次全部通过；未重复其余五场景。

原始差异中的空白上下文行按 patch 格式保留，外层副本以 six-to-final.diff.gz、prepare-extraction.diff.gz 保存，解压后字节不变；records.tar.gz 内也保留原名及原文，原始 manifest 按解压后的内容核对。
