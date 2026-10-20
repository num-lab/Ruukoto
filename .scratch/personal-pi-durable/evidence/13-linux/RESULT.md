Linux 隔离验证完成；主工作区全程只读。原始日志、完整输入清单、执行脚本和清理证据保存在[原始材料归档](raw-materials.tar.gz)，下文相对路径均指归档内路径。

基点为 `dcf094a4e2006fadb9aacde081ed6683b9277e1f`，输入包含当时 tracked 与 untracked 文件去重后的 2372 项，共 80,491,419 字节。逐文件 SHA-256、类型、权限及大小见 `input-manifest.json`，运输归档 SHA-256 为 `aca53589c0a4e5fa184a117654e373f857938edb2bf24c249b9c6ccadc683d22`。远端在任何安装与测试前逐项核对全部输入，普通文件权限保留、符号链接权限不作跨系统比较。32 份 personal 源码和测试另列于 `runtime-input-manifest.json`。

环境为 `ssh tx`，Ubuntu 24.04.4 LTS x86_64、Linux 6.8.0-117-generic、Node v24.21.0、npm 11.19.0、Python 3.12.3、Git 2.43.0。根盘仅剩约 681 MiB，故 `/tmp/rk13-u6_eywbx/repo` 指向本轮专用 `/dev/shm/rk13-u6_eywbx/repo`，npm 缓存与 TMPDIR 均属于本轮 `/tmp` 专属目录。未修改或清理既有缓存、目录、服务和凭据。

每个命令显式设置 `RUN_MODEL_CHECK=0`；准确参数、环境、开始/结束时间、退出码和完整 stdout/stderr 见 `remote-logs/`。本轮只执行一次完整测试，没有增量拼接计数。

- `npm run setup -- --skip-hooks`：exit 0，152.24 秒；按两份锁文件完整安装 847 与 269 个包。npm 11.19.0 报告部分 install scripts 未获 allowScripts 授权，本轮未主动设置跳过安装脚本；下述测试与 build 均实际执行通过。
- `npx --no-install tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-delegations.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`：exit 0，257 pass / 0 fail / 0 cancelled / 0 skipped，47.39 秒（测试 runner 内部 46.73 秒）。包含真实 SQLite 与进程强杀恢复检查，模型、Telegram 与服务调用为离线替身。
- `npm run build`：exit 0，1.87 秒，worker、脚本 worker 与双产品包构建完成。

最终本地 `current-runtime-input-check.json` 与远端 `remote-logs/final-runtime-input-check.json` 均核对全部 32 份 personal 源码/测试，SHA-256 与被检输入一致，本地文件集合也一致。`cleanup.*` 与独立后查 `post-cleanup.*` 证实两个远端专属目录、缓存和临时目录均已删除，目录内残留进程为零，无需终止进程。清理后根盘余 680 MiB、tmpfs 余 1.8 GiB。未收集全量进程参数或环境变量。

创建远端目录前曾发生一次 SSH shell 引号错误；当次未创建远端目录，也未启动安装与测试。修正后完成上述完整运行，原失败见 `preflight-shell-quoting.*`。

未执行真实模型、真实 IM、真实 systemd、全仓检查或 Node 22.19/24.15 精确版本矩阵；本轮离线测试和构建不替代这些验收。
