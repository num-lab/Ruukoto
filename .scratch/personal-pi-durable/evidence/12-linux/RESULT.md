Linux 隔离验证完成；工作区全程只读。

基点为 `06488645e1d50ed48e50230459c484cc0b2ac17f`。初始输入为当时 tracked 与 untracked 文件去重后的 2327 项，共 79,229,871 字节；逐文件 SHA-256、类型、权限与大小见 `input-manifest.json`，归档 SHA-256 为 `9b3a0cd53a2923b84d2792d9e676f6cbd99a2b4b4615d87a26f40422d8dc45b2`。远端逐项核对内容、类型与普通文件权限，符号链接权限不跨系统比较。首轮在 Python tarfile 的 data filter 将既有证据文件 0664 收成 0644 时于输入核对停止，未执行 setup；修正隔离 runner 保留普通文件权限后，以完全相同归档重新核对并执行。该前置失败见 `attempt-1/`。

实际命令、开始/结束时间、退出码与完整 stdout/stderr 保存在 `remote-logs/`。每个命令显式设置 `RUN_MODEL_CHECK=0`，npm 缓存与临时目录均属于本轮专属目录。

- `npm run setup -- --skip-hooks`：exit 0，147.1 秒。
- `npx --no-install tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts`：exit 0，230 pass / 0 fail / 0 skipped，46.2 秒（runner 内部 45.4 秒）。包含真实 SQLite 与进程强杀恢复检查；模型和平台为离线模拟。
- `npm run build`：exit 0，1.6 秒。

首轮冻结后仅 `test/personal-work-notes.test.ts` 新增一项错误工具来源用例，并扩充既有 CLI 用例的应答丢失断言；运行时代码未变。该文件上传前后核对 SHA-256，再运行 `npx --no-install tsx --test test/personal-work-notes.test.ts`：exit 0，20 pass / 0 fail / 0 skipped，11.8 秒（runner 内部 11.4 秒）。首轮该文件为 19 项，所以两阶段覆盖 231 个唯一用例，实际执行 250 次；这不是一次完整 231 项运行。增量内容、原/新 SHA、时间见 `input-overlay.json`；增量测试源码另存 `updated-personal-work-notes.test.ts`，初始源码另存 `initial-personal-work-notes.test.ts`。最终完整输入清单见 `effective-input-manifest.json`。

环境为 `ssh tx`，Ubuntu 24.04.4 LTS x86_64、Linux 6.8.0-117-generic、Node v24.21.0、npm 11.19.0、Python 3.12.3、Git 2.43.0。preflight 根分区仅余 620 MiB，故 `/tmp/ruukoto-work-notes-20261017T043736Z-62zcy7u_/repo` 指向本轮专用 `/dev/shm/ruukoto-work-notes-20261017T043736Z-62zcy7u_/repo`；缓存位于同一专用 `/tmp` 目录，未修改或清理已有缓存、服务、凭据或其他目录。

最终本地 `current-runtime-input-check.json` 与远端 `remote-logs/final-runtime-input-check.json` 均核对全部 30 份 personal 源码/测试，SHA-256 与有效被检输入一致；本地文件集合也一致。`cleanup.*` 与 `post-cleanup.*` 证实两个远端专属目录、缓存和临时目录均已删除，目录内残留进程为零，无需终止残留进程。清理后根分区余 619 MiB、/dev/shm 余 1.8 GiB。未收集全量进程参数或环境变量。

未执行真实模型、真实 IM、真实 systemd 或全仓检查；离线定向测试和构建不能代替这些验收。
