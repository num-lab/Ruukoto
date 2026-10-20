# Linux 真实个人命令 worker 验证

最终轮在 tx 的 Linux 6.8.0-117 x64、Node v24.21.0、bubblewrap 0.9.0、systemd 255 user manager running、cgroup v2 上执行，七项场景通过。最终 worker SHA-256 为 `c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3`，对应源码 SHA-256 为 `c13a477a2432fd1b06ad1dfb5a7d0bb85135acb9e422eb564de80fffa7519503`。`source-comparison.json` 对照运行后共享工作区，生产文件与快照一致。

探针直接调用真实 `prepareNativeLaunch({ workerPath, dependencyRoots: [], protectedRoots }, spec)` 与 `launchLinuxExecution`，不手写 prepared 输入；源码和私有认领目录作为保护根。独立副本没有仓库 node_modules。探针通过 esbuild 打成纯 Node bundle，输出放在 `source/packages/agent/src/execution/linux-probe.mjs`，保持 `native.ts` 从 `import.meta.url` 推导 codeRoot 的目录层级；个人 worker 产物单独位于 `source/worker/`。每次在 launch 返回后接好 stdout/stderr/exit，再关闭 stdin 提交 JSON。宿主既有 npm 工具链的 `node_modules/npm` 仍由原生准备提供，此项不是 Pi 或仓库依赖。

- `evidence/summary.json`：最终七场景的输出长度/哈希、退出状态、setsid 身份、scope 观察和心跳冻结结果。
- `evidence/*-input.json`：实际命令、权限 spec、prepared 挂载和输入；两后代场景由独立 owner 进程启动，主探针按保存的原 ref 停止，其中一项先 SIGKILL owner。
- `evidence/*-stop.json`：原 ref 停止 true、重复停止 true、同 ref 再启动以 `execution_claim_failed` 拒绝，之后才清理 fixture 与 native 临时目录。
- `evidence/cleanup.json`：七个 scope 均 not-found 且 ControlGroup 为空；七个 native 临时路径已删除，本次匹配进程为零。
- `evidence/restricted-positive-control.json`：同一宿主可读合成文件并可连接临时 localhost 服务。沙箱内读取 ENOENT、写入 EROFS、网络建 socket EPERM，原合成文件不变。
- `source-manifest.json`、`source-files-final.tar.gz`、`source/`、`metafile.json`：最终内容哈希、生产快照、自包含可运行探针和构建依赖清单；`commands.json` 记录实际构建、上传与运行命令。

覆盖立即 `exit 0`、stdout/stderr 二进制和退出 37、Shell TERM 得 143、stdout 2 MiB/stderr 1 MiB 原字节、未授权文件读写与网络拒绝、setsid 后代在 owner 存活及 owner SIGKILL 后的停止。两后代场景均核实心跳停止至少 250ms，原 scope 停止证明与重复核实为 true。

`evidence-initial/` 保留首轮探针自身错误：把任何 node_modules 路径都断言为不允许，误把已有 npm 工具链当成 Pi 依赖；失败发生在 prepare 之后、launch 调用之前，没有命令派发。认领目录为空、native 临时目录无 network.bpf，清理记录见其中 `initial-cleanup.json`。仅将断言缩小为不允许整个 node_modules 根，未修改生产实现。`evidence-intermediate/` 保留目录身份修复后的前一版 worker 七项通过；最终轮是在 verifyWorkspace 结构整理后复制新产物，重新运行相同七项，不累加为十四项。

未运行 Linux 全产品构建、全量测试、durable 命令业务链、完全访问、MCP、真实模型或 IM；本材料不把命令输出或退出状态当作可信外部效果回执。没有部署或操作生产服务，没有上传凭据。
