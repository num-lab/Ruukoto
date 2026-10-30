# 第四阶段：Linux 共享执行回归与资源清理

2026-10-12，在 tx 的独立系统服务环境完成 38/38 个不同用例，失败、取消与跳过均为 0。随后清理本次验证账户、user manager、165 个只读依赖挂载及两套源码快照；在线个人实例持续为 `active`，PID 仍为 `3963064`。异常占用与崩溃现场按原状态保留。

## 环境与结果

环境为 Ubuntu 24.04.4、Linux 6.8.0-117-generic、systemd 255、Node `/usr/local/bin/node` v24.21.0、cgroup v2。三个验证单元均为独立系统级临时 service，User=996 / Group=985，工作目录 `/tmp/ruukoto-native-stage2-20261012/repo`；明确设置 `PATH=/usr/local/bin:/usr/bin:/bin`、`RUN_MODEL_CHECK=0`、`XDG_RUNTIME_DIR=/run/user/996` 和 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus`。该目录复用第二阶段的只读第三方依赖和指向隔离源码的 workspace 链接，使用第三阶段更新并构建后的源码与 worker，没有借用在线进程的登录环境。

| 定向测试 | 不同用例 | 覆盖与证据 |
| --- | --- | --- |
| `test/101-native-execution.test.ts` | 4/4 | 网络过滤、当前启动账户、硬链接别名、授权规范化与启动前拒绝 |
| `test/101-native-linux-scope.test.ts` | 3/3 | 完整 cgroup 空成员证据、manager 可用但缺 scope ControlGroup、已知 scope 但 `cgroup.kill` 不可写 |
| `test/100-worker-stop.test.ts` | 31/31 | 启动取消与迟到单元、保留 typed ready 原因及停止身份、查询失败与停止预算、Runtime 保留未知退出、真实原进程组与独立 Shell 组后代停止 |

原始命令和 TAP 结果见 [Linux 测试日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage4-linux-tests.log)。`ruukoto-stage4-linux-static` 先运行 execution 的四项和 scope 原有的一项，`ruukoto-stage4-linux-stop` 运行全部 31 项；更新后的 scope 文件随后由 `ruukoto-stage4-linux-scope-negative-final` 运行三项，因此同一项 scope 证据检查实际运行两次，38 是不同用例数。上传 scope 文件的首次路径写入被权限拒绝，没有把随后仍含旧文件的运行计为新增反例通过；最终通过临时上传再按 UID/GID 安装，日志中的 final 单元明确包含全部三项。

```bash
node --import tsx --test test/101-native-execution.test.ts test/101-native-linux-scope.test.ts
node --import tsx --test test/100-worker-stop.test.ts
node --import tsx --test test/101-native-linux-scope.test.ts
```

两个新增 scope 反例使用受控 `fs` / `child_process` 边界，不启动真实进程：模拟 manager 可用和已创建单元，再分别令 ControlGroup 缺失或 `cgroup.kill` 返回 EACCES，核实 `execution_unavailable/policy_missing`、保留原 systemd 单元及 stop 接口、只启动一次且无替代后端。它们同时在本地 macOS 3/3、定向 ESLint 和 TypeScript 检查通过。真正 Linux 缺委派验证在[第一阶段报告](stage1-server-report.md)中命中 user manager 构造失败；不把此结果与新增反例混称为同一条真实系统权限验证。

真实后代停止用例在 Linux 没有跳过。第一阶段另外验证了正式 bwrap scope 中的 `setsid` 后代、服务强杀、退出登录后定时委派、隔离 VM 的真正 reboot 自动运行及拒绝前置；[第二阶段报告](stage2-report.md)记录个人链，第三阶段的 Linux Coding Agent 原生回归见 [worker 10/10](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage3-linux-coding-worker.log) 与 [worktree 8/8](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage3-linux-coding-worktrees.log)。这些通过结果不取代本表的共享测试。

## 部署模板

以验证账户及实际 Node 绝对路径替换 systemd 模板后，`ssh tx 'sudo systemd-analyze verify /tmp/ruukoto-backend-stage4-template.service'` 返回 0，见[原始记录](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage4-systemd-verify.log.gz)。唯一输出来自既有 `tat_agent.service` 使用 `/var/run` PIDFile 的兼容提醒，与本次单元无关。此次只验证模板，没有替换或重启在线后台。

## 清理与保留

清理前，UID 996 无 native scope，只有 `systemd --user` 与 `sd-pam`，本次运行的后台、测试服务及 QEMU 均已停止。先留存错误设计的 missing-bus 单元 journal，再关闭本次 linger、停止 `user@996.service` 与 `user-runtime-dir@996.service`，确认该 UID 没有进程。随后按路径从深到浅卸载两个唯一目录前缀下的 165 个 bind，确认无剩余挂载后才删除源码、依赖挂载目录、临时 HOME 与账户，最后仅 reset 本次 failed 单元。没有在仍挂载时删除目录或递归改所有者。

清理前核实、执行末段与最终断言见[清理记录](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage4-cleanup.log.gz)；卸载命令的中间输出在工具返回时截断，记录明确保留这一缺口，没有补写成原始输出。清理脚本退出 0，终态再次核实没有 UID 996 进程、账户或对应依赖挂载，`ruukoto-*` 系统单元只剩在线 `ruukoto-backend.service`，仍为 PID 3963064 / active。`kernel.apparmor_restrict_unprivileged_userns=1`，`/usr/bin/bwrap` 仍为 root:root / 0755。tx 根盘剩余约 1.3 GiB，`/dev/shm` 剩余约 1.9 GiB。

以下目录及记录保留，删除验证账户后文件仍以原数字 UID 持有，不重写占用状态：

- `/tmp/ruukoto-native-stage1-20261012/state`：1.5 MiB，保留第一阶段强杀后的未知占用。
- `/tmp/ruukoto-it-smoke18-FoO4VB`：6.5 MiB，保留初次断言失败的真实崩溃现场。
- `/tmp/ruukoto-it-smoke18-bANVC0`：2.5 MiB，保留最终 main 中断与 paused/occupancy_unverified 现场；只读查询见[崩溃状态](stage2-retained-crash-states.json)。

隔离 VM 已关机，QEMU 不再运行，overlay 与只读 base 镜像已释放；其 journal、boot ID、结果及脚本均已复制入本工单。为验证安装的 QEMU 软件包保留。既有生产账户、Docker、生产档案与线上服务配置没有修改。

此分支没有运行全量仓库检查，也未执行真实模型或 QQ/Telegram 外发；主代理汇总静态门禁、离线应用回归、构建与升级 smoke 的证据。
