# 工单 31 独立 Linux 定向验证

通过 `ssh tx` 在独立 `/tmp/ruukoto-31-linux.zdImFh/repo` 执行，环境为 Linux x64、Ubuntu 内核 6.8.0-117-generic、uid 1003、Node 24.21.0。没有读取生产档案或启动旧个人后台；测试创建隔离档案和回环模型／消息平台替身，生产路径的 sudo 接线使用测试命令桩，不代表真实 sudo/systemd 或真实 IM 验收。

`node --import tsx --test --test-concurrency=1 test/personal-qq.test.ts test/personal-cli.test.ts` 为 49/49，零失败、零跳过，约 29 秒。覆盖 macOS 唯一跳过的“服务核实 HTTP：Linux sudo 接线、原状态刷新及慢停止不阻塞独立聊天”，也覆盖 Linux 后台启动/恢复及最终 QQ 重复 poll 拒绝/状态保留回归。原始记录见 `records/personal-tests.log` 与 `records/test-results-personal.json`。

`node --import tsx --test --test-concurrency=1 test/26-qq.test.ts test/40-qq-private.test.ts test/41-qq-private-scope.test.ts test/89-im-entries.test.ts` 为 17/17，零失败、零跳过，约 22 秒。共享调用方在之后的个人收件 loop 改动中不受影响；最终个人测试重新覆盖该改动。原始记录见 `records/shared-tests.log` 与 `records/test-results-attempt1.json` 的 shared 项。

运行前核对 592 个源码文件与 285 个运行／测试依赖包，均无差异；最终本机再对照 root 源码，592/592 一致。没有改写测试或转成 bundle，直接运行原 TypeScript；本机依赖按原嵌套目录复制，避免两个 Pi 版本互换。唯一复用项为远端已有的 esbuild 0.28.1 Linux 二进制，路径与 SHA-256 记在 `records/cleanup-preflight.json`，缓存只读且保留。

准备阶段的远端 `npm ci --ignore-scripts` 因 ENOSPC 失败，已删除本次目录内的不完整安装，再以依赖闭包完成验证；安装记录见 `records/setup.log`。personal 首次加载还因未复制测试直接依赖的 root chord 0.85.1 失败，补齐该依赖后通过；失败原始日志保留为 `records/personal-load-attempt1.log`，不计作产品断言失败。

`source.tar.gz` 保存运行源码快照，SHA-256 为 `ac47bd04fbccf620b730c2f453d31fef4bd5717595c0a1fac6d684eb2646b2cf`；`records.tar.gz` 保存 14 个原始材料，SHA-256 为 `c32215e631ac3ccab5b9359bcb14e7ce73b3bc41b9e3939abdbd3b21bda350da`。下载后已核对归档 SHA-256 并解出逐文件指纹，见 `archive-verification.json`。

专属目录内的仓库进程为零，已删除整个远端 `/tmp/ruukoto-31-linux.zdImFh`；原缓存保留，事实见 `remote-cleanup.json`。没有跑全量、Linux 构建、其他 Node 版本、真实模型、QQ／Telegram、真浏览器或产品体验验收。
