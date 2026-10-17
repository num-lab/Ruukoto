# Linux durable 个人命令验证

在 tx 的 Linux 6.8.0-117、Node 24.21.0、bubblewrap 0.9.0、systemd user manager running 与 cgroup v2 上执行，最终四项真实 bwrap/user scope 场景通过。只使用 `/tmp/ruukoto-command-25.sSTsx4` 专属目录、临时档案和 MockModelServer，不使用真实模型、IM、生产凭据或部署。

探针经真实 provider HTTP/SSE 驱动 durable 子会话的 run_command 工具，再调用真实 prepare、个人 worker 和原生 scope。SDK 与 typebox 保持原 ESM 包，仅仓库源码通过 esbuild 打包，各 TypeScript 模块的 import.meta.url 保留远端 source 中的原目录语义。宿主运行依赖来自本机已安装的 108 个包的闭包，个人 Pi 1.3.0 及其嵌套版本保持原解析位置；没有 npm 安装或改写 SDK。命令 worker 仍为空运行依赖，宿主 node_modules 不进入命令可见根。

- normal：完整分页读取 7003 字节 stdout 和二进制 stderr，退出 37 记运行返回；命令 Task 原生归 WorkTask 持有，工作完成后释放并复用同一子 Agent，执行计数只有一行。
- no-receipt-crash：外部 count 已写入且宿主已捕获输出时 SIGKILL owner；没有完成回执，恢复只核实原引用并停止，保持未知与占用；人工独立效果说明和原引用停止满足后释放，命令不重发，主聊天可以继续。
- receipt-before-observation：真实宿主回执发布后，在 durable CommandObservation commit 前 SIGKILL owner；恢复按原执行和指纹找回 returned/37、双流与停止事实，完成原工作，无新命令执行。
- stop-unverified：真实停止原执行后，暂时移走整个原 native claim；恢复与独立停止均保守停止未核实，不创建 stop-first 替代认领，人工效果说明不能释放占用。将原私有认领目录 rename 回原路径后按原引用重核停止，才完成原工作并复用身份。

summary.json 保存四项原任务、工具结果、输出长度/哈希、复用身份及 MockModelServer 输入。cleanup.json 核对四个原 scope 全部 not-found、ControlGroup 为空，四个原临时目录消失且 fixture 根为空；process-cleanup.json 另外核对匹配进程为零。source-manifest.json、source-comparison.json 与 remote-source-comparison.json 核对实际运行的 34 个生产源/worker、本机当前根工作区、远端副本及探针 bundle 哈希一致。

records.tar.gz 保留最终 evidence、各次失败材料、原 SQLite/私有回执/双流/原生认领、源码镜像和运行日志；artifact-manifest.json 对其中 211 份证据逐项记录长度与 SHA-256，并已从归档逐一复核。source-files-tested.tar.gz 单独保存同源生产文件和自包含仓库探针，不含 node_modules。probe-entry.mjs、build-probe.mjs、copy-runtime-dependencies.mjs 和 runtime-dependencies.json 保存探针、构造方式及精确包清单。完整宿主依赖复现包 source-with-runtime-final.tar.gz 仅留在本机 `/tmp/ruukoto-command-25-linux-20261017/`，不需入库；共享锁文件及包清单可用于重新准备依赖。

历史材料不累计为额外通过：前两次在命令接纳前遇到 SDK 被 bundle 改写初始化顺序，尚未执行命令；第三次是复跑时空 fixtures 目录的 EEXIST。pre-final 轮前三项完成，第四项的探针使用 fs.cpSync 恢复目录导致权限变为 0775，产品正确拒绝不可信证据并继续保留占用；修正为 rename 保留原权限后，使用最后冻结源码完整重跑四项通过。pre-final 的四个 scope 和临时目录亦已全部清理。

没有运行 Linux 全量构建或全量应用测试，不覆盖真实模型、IM、完全访问、MCP 或拥有者产品体验。远端专属目录的删除结果由 remote-artifact-cleanup.json 持有。
