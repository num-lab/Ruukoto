# 第三阶段：Docker worker 交付清理与共享回归

2026-10-12，第二阶段出口通过后应用交付清理：删除 `deploy/worker-image/`、`build:worker-image`、`test:docker` 和基础验证的 `container-worker-smoke.mts`。新 `test:native` 顺序运行个人 04/13/15/18/28，`linux:probes` 改运行正式 `/usr/bin/bwrap` 原生探针。旧 `linux-isolation` 对照脚本和结果作为明确历史材料保留。26 删除已失效的 Docker 环境变量及不可用证据说法，保持 coding 身份和原场景。

本地 `npm run test:foundation` 为 9 passed、1 个真实模型用例按要求 skipped，`test/99-verification-entrypoints.test.ts` 为 6/6；Linux 原生 Python 探针 `--self-check` 通过，相关 smoke 的 ESLint 与 diff 检查通过。99 清理无调用者的假 Docker 夹具，保留模型缺认证时不启动 TUI 的负例。

## Linux 真实 Coding Agent 回归

使用第二阶段的独立检出与 UID 996/GID 985 系统服务环境，读取更新后的源码，不接触在线实例。依赖仍为只读 bind，账户没有 Docker 组或 socket 读写资格。删除隔离源码中对应的旧镜像目录及容器 worker 探针后，[重新构建 worker](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage3-build-worker.log)通过，实际源码见 [哈希](stage3-source-hashes.json)。

| 入口 | 结果 | 原始记录 |
| --- | --- | --- |
| `node --import tsx verification/smoke/smoke-26-native-worker.mts` | 原 10 项全部通过，退出 0 | [worker](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage3-linux-coding-worker.log) |
| `node --import tsx verification/smoke/smoke-26-native-worktrees.mts` | 原 8 项全部通过，cleanupVerified=true，退出 0 | [worktrees](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage3-linux-coding-worktrees.log) |

worker 覆盖四工具、宿主工具链、文件/网络/FD/环境隔离、身份替换、硬链接、启动取消和真实后代停止，以及默认原生的正式按需后台。worktrees 保留修复前失败/修后通过、限定只读范围、两个并行副本、共享 Git 拒写、父未提交改动保留、汇总与停止核实。

macOS 的相同原生回归、双产品升级与最终文档由第四阶段持有。本阶段不调用真实模型或 IM。第二阶段 18 的两个 main 崩溃异常现场仍完整保留，没有以释放占用或删除资料收尾。
