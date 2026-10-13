# 第三阶段：生产执行路径清理回归

2026-10-12，macOS arm64、Node 24.15.0、UID 501。在第二阶段个人原生链路通过后，应用生产清理：删除 Docker worker 启动器、配置和类型，删除 VM inode 例外与容器 UID/GID 预检，统一宿主目录身份和实际账户的权限预检；保留 local 完全访问、systemd_unit、停止未核实占用、类型化原始 cause 和材料分析的空 readRoots 护栏。环境原始值见[记录](stage3-production-environment.json)。

| 检查 | 结果 | 原始记录 |
| --- | --- | --- |
| `npx tsx --test test/07-real-tools.test.ts test/10-access-modes.test.ts test/22-auto-review.test.ts test/83-subagent-worktrees.test.ts test/95-work-copy.test.ts test/100-worker-stop.test.ts test/101-native-execution.test.ts test/101-native-linux-scope.test.ts` | 102/102，通过，24.24 秒 | [日志](stage3-production-tests.log) |
| `npx tsx --test test/84-subagent-integrate.test.ts` | 13/13，通过，26.63 秒 | [日志](stage3-integrate-tests.log) |
| 23 个相关源码与测试文件的定向 ESLint，`--max-warnings=0` | 通过 | [日志](stage3-production-eslint.log) |
| `git diff --check` | 通过 | 无输出 |

额外运行 84 是因为它与 83 共用受控工作副本 fixture；fixture 现使用 native 启动器身份和 systemd_unit 单元身份，汇总后停止失败仍需核对父目录占用及双方成果保留。

本批使用离线模型、真实 local worker、文件、Git 和同组进程，并用受控单元覆盖启动与停止失败。Linux scope 用例核对文件夹具里的成员证据，不代表实际 Linux cgroup 或 macOS Seatbelt 验收；真实原生和个人系统服务的证据仍分别由前两阶段及后续共享平台回归持有。此批未运行真实模型、IM、生产部署或全量检查，notes 由最终交付阶段统一处理。
