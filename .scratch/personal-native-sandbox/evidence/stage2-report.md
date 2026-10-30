# 第二阶段：个人原生执行链

2026-10-12，在 tx 的独立源码目录 `/tmp/ruukoto-native-stage2-20261012/repo` 验证。每个脚本从独立系统级临时 service 启动，User=996、Group=985，HOME 为本次临时目录；传入 `/run/user/996` 和对应 user bus，不使用交互登录环境替代。运行账户属于新建的 ruukoto-native-check，补充组只有 985，Docker socket 无读写资格，详见 [环境原始记录](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-environment.log)。原生前置由第一阶段持有，本阶段不操作在线实例或修改系统策略。

源码只传入新检出；第三方依赖使用 77 个只读 bind，新 `@ruukoto` 相对链接指向新源码，不运行 npm install 或修改共享依赖。挂载列表见 [临时依赖挂载](stage2-dependency-mounts.txt)，实际文件版本见 [源码与 worker 哈希](stage2-source-hashes.json)。[worker 构建](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-build-worker.log)通过；模型均使用本地确定性桩，18 的 QQ/Telegram、28 的通知渠道也使用桩。

| 脚本 | 结果 | 真实资源与证据 |
| --- | --- | --- |
| 04 | 6/6，通过 | 四工具修改与检查、文件/网络/系统根拒绝、越界审批单次消费、当前账户完全访问、心跳停止与 scope/cgroup 核实。[原始日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke04-initial.log) |
| 13 | 6/6，通过 | 个人普通开发会话，实际活动父轮、协作加入、双方真实 read 与工作内消息、主 Agent 补充/子任务汇报、复用关闭、真实个人 CLI 与重启幂等；读取操作与实际正文均核实。[原始日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke13-final.log) |
| 15 | 8/8，通过 | 原生首次与继续 read；排队/遗留占用的恢复、未核实拒绝、个人 CLI 核实恢复、宿主固定评审及重复重启。崩溃持久形态由裸 SQLite 播种，不将它当作 OS 强杀复现。[原始日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke15-final.log) |
| 18 | 7/7，通过，预期保留 main 崩溃现场 | 正式个人 server、原生 Git 初始化/modify worktree、共享 Git 拒写、子任务运行期间主聊天响应、原 IM 汇报、离线/改绑/跨平台续派、真实 SIGKILL 后一次中断汇报。真实子任务 scope 已停止，主唤醒异常占用保留。[原始日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke18-crash-occupancy.log) |
| 28 | 全部通过 | 个人 main 并行双 worktree、四工具、当前 UID/最小环境、共享 Git 拒写与汇总；独立定时 confirm/auto-review/full_access 的真实 read、模式传播、运行中主聊天响应、工作内消息与一次汇总。[原始日志](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke28-initial.log) |

脚本入口为 `node --import tsx verification/smoke/<文件>`。外层启动使用 `sudo systemd-run --wait --pipe --collect --uid=996 --gid=985 --working-directory=/tmp/ruukoto-native-stage2-20261012/repo`，并明确设置 `PATH=/usr/local/bin:/usr/bin:/bin`、`HOME=/tmp/ruukoto-native-stage2-20261012/home`、`XDG_RUNTIME_DIR=/run/user/996`、`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/996/bus`。这是新系统单元，脚本仍各自创建独立 mkdtemp 档案。

## 保留的现场与失败结果

18 最终运行保留 `/tmp/ruukoto-it-smoke18-bANVC0`，main 唤醒 `task_a8f6c764218bf3f5552ea032` 为 interrupted/backend_restart，主会话 paused/occupancy_unverified。没有恢复队列、删除记录或把未知状态清空；全部子任务 scope 的成员停止另行核实。保留状态的只读查询见 [记录](stage2-retained-crash-states.json)。[运行后原生单元列表](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-native-units-after.log)为空。

13/15 首跑揭露旧脚本由已完成父任务直接发起新管理操作，与现行 task_ending 约束不符；修成实际活动父轮后重跑。18 首跑的新增全库 occupancy=0 断言误把 main 强杀后的保留视为失败，修成核对具体被杀唤醒、其 paused 状态与子占用释放。初次失败原始记录分别保存在 [13](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke13-initial.log)、[15](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke15-initial.log)、[18](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke18-initial.log)，中间活动父轮复跑分别见 [13](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke13-active-parents.log)、[15](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-native-sandbox%2Fevidence%2Fstage2-smoke15-active-parents.log)。18 初次失败现场 `/tmp/ruukoto-it-smoke18-FoO4VB` 也保留，未把旧失败改写成通过。

本地 TypeScript、相关 smoke ESLint、入口测试 99 的 6/6 与 diff 检查通过。真实模型、真实 QQ/Telegram 与生产部署没有执行；升级 24 和 Docker 交付删除后的 Coding Agent 双平台回归留给后续阶段。
