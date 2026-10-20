Linux 隔离验证完成。

基点：`a54d5b6a4b1facbe3285eb4dc92f84b1a4a4c0e1`。初始输入为当时全部已跟踪文件，加新增 `apps/ruukoto/src/personal-work-controls.ts` 与 `test/personal-work-controls.test.ts`，去重后共 2208 文件。逐文件 SHA-256、类型、权限与字节数见 `input-manifest.json`；归档 SHA-256 见 `source.sha256`。远端解包后对每个输入核对类型与内容摘要，普通文件另核对权限；符号链接不比较跨系统权限位。

首轮命令均设置 `RUN_MODEL_CHECK=0`，使用本轮独立 npm 缓存；实际命令、开始/结束时间、退出码、stdout/stderr 保存在 `remote-logs/`。

- `npm run setup -- --skip-hooks`：exit 0，110.8 秒。
- `npx --no-install tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`：exit 0，207 pass / 0 fail / 0 skipped，39.8 秒（runner 内部 39.0 秒）。其中包括原有取消事实落盘后真实 SIGKILL 恢复用例。
- `npm run build`：exit 0，2.0 秒。

独立审查后仅 `test/personal-work-controls.test.ts` 新增两条精确取消窗口用例，生产代码未变。上传前后核对该文件 SHA-256，再运行 `npx --no-install tsx --test test/personal-work-controls.test.ts`：exit 0，13 pass / 0 fail / 0 skipped，10.0 秒（runner 内部 9.5 秒）。首轮该文件为 11 项，所以两阶段合计覆盖 209 个唯一用例；这不是一次完整 209 项运行。增量内容、时间与摘要见 `input-overlay.json`、`remote-logs/input-overlay.json`；最终完整输入清单见 `effective-input-manifest.json`，最终测试源码另存 `updated-personal-work-controls.test.ts`。

环境：`ssh tx`，Ubuntu 24.04.4 LTS x86_64，Linux 6.8.0-117-generic，Node v24.21.0，npm 11.19.0，Python 3.12.3。根分区仅余 625 MiB，因此 `/tmp/ruukoto-work-controls-20261017T040936Z-he27jsp3/repo` 指向本轮专用 `/dev/shm/ruukoto-work-controls-20261017T040936Z-he27jsp3/repo`；npm 缓存在本轮 `/tmp` 目录，未修改或清理用户缓存。

最终本地 `current-runtime-input-check.json` 与远端 `remote-logs/final-runtime-input-check.json` 均核对全部 28 份 personal 运行时/测试文件，SHA-256 与有效被检输入完全一致。`cleanup.*`、`post-cleanup.*` 证实本轮两个远端目录与专用 npm 缓存已删除，残留目录内进程为零。远端环境日志未收集全量进程参数或环境变量。

未执行真实模型、真实 IM、真实 systemd 操作或全仓测试；离线用例与构建不能替代这些验收。
