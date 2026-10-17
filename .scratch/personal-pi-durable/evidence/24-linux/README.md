# Linux 个人命令宿主消费者验证

在 tx 的 Linux 6.8.0-117、Node v24.21.0、bubblewrap 0.9.0、systemd user manager running、cgroup v2 上执行，最终七项真实 bwrap/user scope 场景全部通过。本轮只使用 `/tmp/ruukoto-command-24.uPkbfF` 专属目录，没有 npm 安装、凭据上传、生产服务操作或部署。

探针调用真实 `prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots }, spec)` 后调用 `runPersonalCommand`；没有构造假的 PreparedNativeLaunch。源码经 esbuild 打成纯 Node bundle，各 TypeScript 模块的 `import.meta.url` 保留远端 source 镜像中的原目录语义，worker 自包含产物单独复制到 `source/worker/`；远端 source 没有仓库 node_modules。

- `evidence/summary.json`：七项结果、回执、停止及清理事实；分别覆盖二进制 stdout/stderr 和退出 37、新进程读取、同 ref 不能重放、3 MiB 双流长度与哈希、timeout/cancel 下 setsid 后代、独立新进程停止与活 run 并发时不发布回执、owner SIGKILL 后无回执且不重放、原 ref 新进程停止及临时目录替换保留。
- `evidence/*-input.json`：实际命令、固定 ref、LaunchSpec 与真实 prepared 输入。`*-records/` 保留私有请求、原始双流、完成回执（若存在）及原生认领记录。
- `evidence/*-stop.json`：每场景原 ref 独立新进程停止及重复停止。替换目录场景首先要求 `exited=true/cleaned=false` 且 marker 原样保留，随后仅在退出证明成立后由探针清理自身建立的替换目录与移开的原临时目录。
- `evidence/cleanup.json`：七个 scope 全部 `LoadState=not-found`、ControlGroup 为空，七个原临时目录和移开的原目录均不存在，fixture 根已删除，本次匹配进程为零。
- `source-manifest.json`、`source-comparison.json`、`source-files-tested.tar.gz`、`metafile.json`：真实运行内容哈希、当前工作区十文件一致性、源码快照与打包依赖。

`evidence-initial/` 保存增加独立停止门禁和 temp 独占认领前的六项通过。`evidence-intermediate/` 保存新增独立 stop 场景的探针自身失败：用 `execFileSync` 等待新进程停止，阻塞活 run 所在 Node 事件循环，导致 launcher 无法及时回收，停止保守返回 false；scope 已退出，owner 退出后独立重核 true 并清理。最终探针改为异步新进程等待，使用包含 stop-requested 门禁及 temp 路径/身份独占的最终源码重跑七项；不把历史轮次累计为额外通过。

没有把退出码或 stderr 解释为业务效果。未运行 Linux 全量构建或全量测试；不覆盖 durable 模型工具、权限、审批、工作暂停/占用、完全访问、MCP、真实模型或 IM。捕获/回执写失败、损坏记录等离线覆盖由实施者另行持有。

完整探针、原始记录和历史轮次保存在 `records.tar.gz`，以上 `evidence/` 等路径均相对其解包目录；顶层另留最终 summary、cleanup 和环境 JSON 便于核对。源码归档、探针与清单同时保留顶层副本。
