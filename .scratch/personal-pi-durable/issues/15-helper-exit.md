# 服务 helper 中断等待调用进程关闭

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)与[规格](../spec.md)的 A3/A5/A9。核实子工作工具接入前提时发现 `callHelper` 在超时或取消发出 SIGKILL 后立即拒绝，调用方可能在进程尚未关闭时收尾。本片修复这个共用传输窗口，等待原调用进程关闭并收齐有界输出，再返回原失败。不开放子 Agent 工具、restart 模型工具、正式入口或部署；后台 SIGKILL 留下 detached helper 的恢复核实仍是子工具接入前提，不能以本片通过替代。

## 方案

- 超时、取消和输出超限只登记首次失败并停止进程组；Promise 在原 child `close` 后拒绝，捕获原始输出直至关闭。异步启动失败同样经 close 收尾，同步 spawn 异常仍直接拒绝。已取消 signal 零启动，监听安装后再次核对 signal，覆盖启动时取消窗口。
- 不把发送信号、调用进程关闭或只读可重放等同于受控服务操作单元停止；restart 的未知效果、stop-op 与人工核实流程保持。停止无法完成时调用保持等待，不伪造已停止。
- 影响 `service-helper.ts` 及三个实际调用方：旧个人 `service-tools.ts`、新个人 `personal-services.ts`、`personal-service-operations.ts`。新增独立传输回归，并保留原调用方测试；不增加包或运行依赖。新个人完整窄集合、旧服务/长期授权及产品入口回归按实际影响执行。
- 先用真实子进程与延迟送达的停止信号证明取消/超时不会提前返回，并验证关闭前尾部字节；覆盖预先取消、启动时取消、输出超限、异步 spawn 失败。独立审查在隔离副本撤去修复验证回归有效。macOS/Linux 分开记录。
- 同步个人模块、服务工具文档及决策笔记；无命令或安装变化。决定依据见[传输退出处理](../../../.agents/notes/implemented/architecture/2026-10-17-service-helper-exit.md)。

## 进展与交接

- 当前角色：工程交接；接手 HEAD `3d53f60`，分支 `Eitrous/migrate-to-pi-durable`，初始工作区干净。拥有者指示接手总工单，已确认总方案继续有效。本次提交承载实现、测试、说明与证据，由相对基点 diff 与[内容快照](../evidence/15-helper-exit.sha256)核对；快照排除工单及证据以免自指。
- 只读调查已核实工具恢复直接进入 execute，现有子会话严格空工具；活进程取消与崩溃孤儿是两个独立问题。当前只修前者，子工具接入方案必须处理后者后再审。
- 独立方案/实现审查 `next_slice` 无阻断：亲跑 notes/docs/diff、6 项传输、113 项旧/新调用方及 2 个异步事件探针；旧 HEAD 隔离反证 3 项预期失败。本机与 Linux 验证完成；本片无拥有者待决产品取舍。
- 下一角色：总工单实施者，为子工具设计持久执行身份与崩溃后停止核实并独立复审，再继续工具权限与委托归属。本片没有未完成验收或阻断；完整迁移仍在总工单推进。

## 验收与证据

- 工程验收：通过。原失败码保留，取消/超时返回时原调用 child 已关闭；关闭前尾部输出与限额捕获正确；取消竞态不留下进程或误报成功；旧/新服务调用方回归通过。
- macOS 27.0.1 / Darwin 27.0.0 / Node 24.15.0 / npm 11.12.1：setup、build、check:static 通过；16 文件相关集合 361/361，零失败/跳过，含个人 12 文件、传输 6 项、旧服务/长期授权与产品入口。Coding 包 shasum 仍为 `5af04e561c9fbf84bf29f8237e3655e563ea5ed9`。完整命令、环境、计数与两份实现哈希见[本机证据](../evidence/15-macos/summary.json)，末轮 docs/diff 通过。
- 独立实现审查直接读规格、实际源码、窄工单及文档/笔记，结论无阻断。新传输 6/6、四文件调用方 113/113、事件探针 2/2；旧 HEAD 副本新测试 3 通过/3 预期失败，分别捕获尾部字节丢失、超时提前返回与安装监听前取消漏接。首轮反例仅用 Node strip-only 时解析失败，不计反证；改用 `--experimental-transform-types` 后得到行为反例。临时副本清理。审查时没有落完整原始日志，[审查材料](../evidence/15-macos/independent-review/README.md)明确是已完成工具响应的记录、摘录及探针脚本，不冒充完整日志。
- Linux 6.8.0-117 / Node 24.21.0 / npm 11.19.0：专属 tmpfs 当前源码副本独立 setup、build 通过；6 文件串行定向 123/123（含新传输、个人 services/operations、旧 78/79、真实 Linux helper-stop 4 项），零失败/跳过。额外无依赖直接传输 6/6 是重复执行，不累加唯一数量。最终 helper/test/锁文件哈希匹配，专属目录、依赖、缓存和夹具清理，cwd 残留进程为空。初次 strip-only 解析失败及缺 Git 根的 setup 拒绝保留，补 transform-types/隔离 git init 后通过，不计行为回归失败；详见[环境与汇总](../evidence/15-linux/summary.txt)、[命令](../evidence/15-linux/commands.txt)及[清理](../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F15-linux%2Fcleanup.log)。Linux 版本不同于 CI 精确矩阵，不声称覆盖 Node 22.19/24.15。
- 产品验收：不适用，本片不新增交互或产品取舍。真实 systemd/sudo、模型/IM 与完整迁移仍待总工单验收；Linux helper-stop 以真实子进程与系统命令桩验证，不代替生产单元。
- 审查覆盖上述内容快照的实现与说明；总工单的进度及本证据补记不改变运行时行为。未跑全仓 check、真实 systemd/sudo、模型/IM 或新产品体验；本片没有新交互或模型文本，未重跑 PTY 或真实模型。

## Comments

2026-10-17：从总工单接手。独立只读调查发现原计划直接下放只读工具仍不能满足崩溃后停止核实，故先修可以独立验证的共用取消窗口；不降低子工作或完整迁移验收要求。

2026-10-17：方案与实现独立审查无阻断；macOS 361/361、Linux 定向 123/123、两端 setup/build 与本机 check:static 通过。只将本片工程验收置 resolved，完整迁移继续 in-progress；未提交、推送或部署。

2026-10-17：拥有者指示提交本片；源码与已验内容快照、独立审查结论一致，工程验收沿用。总迁移与真实环境验收继续待后续，未获推送或部署指示。
