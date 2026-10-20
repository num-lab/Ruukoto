Linux 隔离验证完成。

基点：c1fee03b2fa5c322d46287bfec3228dcd2343649；输入为当前全部已跟踪文件加 apps/ruukoto/src/personal-work-tools.ts、test/personal-work-tools.test.ts。逐文件 SHA-256 见 effective-input-manifest.json；初始归档摘要见 source.sha256。后加真实 SIGKILL 用例在测试启动前同步，时间与摘要见 remote-logs/input-overlay.json。

实际命令（均 RUN_MODEL_CHECK=0，使用本次独立 npm 缓存）：
- npm run setup -- --skip-hooks：exit 0，约 87.2 秒。
- npx --no-install tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts：exit 0；196 pass / 0 fail / 0 skipped，约 33.3 秒（test runner 内部 32.5 秒）。
- npm run build：exit 0，约 2.0 秒。

环境：ssh tx，Ubuntu 24.04.4 LTS x86_64，Linux 6.8.0-117-generic，Node v24.21.0，npm 11.19.0，Python 3.12.3。所有实际 stdout/stderr、命令、退出码与时间位于 remote-logs/。

存储布局：因根分区仅余 628 MiB，创建专用 /tmp/.../repo 入口，指向专用 /dev/shm/.../repo；npm 缓存保存在专用 /tmp 目录。未修改已有 npm 缓存。首次尝试仅因跨系统符号链接权限位不同停在校验阶段，尚未 setup；第二次对符号链接核对类型与内容摘要、普通文件同时核对权限。

清理：cleanup.stdout、post-cleanup.* 证实本次远端两个目录均删除，目录内残留进程为零。current-runtime-input-check.json 证实全部 26 份 personal 运行时/测试文件与本地当前内容一致。

未执行真实模型、真实 IM、真实 systemd 操作或全量检查；这些结果仅证明本次离线 Linux 用例与构建。
