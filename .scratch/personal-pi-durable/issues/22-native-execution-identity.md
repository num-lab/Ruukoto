# Linux 原生执行的持久认领与停止重核

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)的外部执行阶段，按[规格](../spec.md) A3/A5/A6/A9 补齐通用命令接入前的停止证明。拥有者接手指令及总方案确认继续有效。本片只提供 Linux 受限执行的持久身份 API，不开放命令/MCP工具，不改 Coding 默认启动行为、权限策略、正式入口或部署。

## 方案

- 新增 `packages/agent/src/execution/native-linux-identity.ts`，接收宿主已保存的具名执行引用（随机执行 ID、本机）和私有认领目录，以及现有 `PreparedNativeLaunch`/`LaunchSpec`；复用 bwrap 参数、网络过滤与平台启动核实，不装配旧 ToolRouter/Driver。
- 外调前核实机器、目录属主/权限、路径与 worker 可见根不重叠，原子 mkdir 认领；同 ID 永远拒绝重新启动。认领固定 boot、scope 和参数指纹。停止先手同样认领并持久阻止迟到执行。
- 原 launcher 使用独立进程组；在启动返回前保存 PID/starttime/PGID。每次认领生成仅宿主持有的随机 token，作为 scope Description；收到本次私有 started 标记后，核对 Description、InvocationID 与本次 launcher 的 `/proc` cgroup 成员身份，才持久保存原单元及 cgroup dev/ino。拟用名字不作为已认领单元的证明。
- 停止先保存标记，只有原 Description/InvocationID 与 cgroup 身份仍相符才打开原目录并以 dev/ino 复核，通过目录 FD 打开原 `cgroup.kill` 后写入；不使用按名字的 systemctl kill/stop，避免核对与发信号之间单元换代。原组已删除时只观察，不触碰同名单元。退出证明同时核实 launcher 原寿命及整组、原 cgroup 与单元状态；原 boot 已结束或可信未派发记录可证明停止。缺/半写身份保持未核实，不对持久 PID/PGID 发信号，not-found 单独不能证明。
- 在原 `launchLinuxNative` 增加本片所需的固定 scope、派发前/后及 cgroup 观察接点，省略时保持原随机 scope、进程及停止语义。失败若已创建单元，继续携带 `ExecutionError.unit`；认领写失败不启动，启动后证据失败保留原身份与现场。
- 文档同步 execution 模块及决定笔记；不新增依赖、配置或命令。后续 durable 在调用前提交执行引用，并将停止未核实接入原工作占用；本片不声称完成该消费者。

## 进展与交接

- 当前角色：工程交接；分支 `Eitrous/migrate-to-pi-durable`，基点 `ba94b7f`，接手时工作区干净。本次提交承载本片实现与证据，实际内容由已验快照核对。
- 只读调查 `next_slice` 核实旧 launcher 只有内存闭包，service helper 不能证明任意命令后代，MCP close 不能证明远端停止。
- 独立方案审查 `next_slice` 直接核对规格、工单、提案与源码；补齐同名身份及目录 FD 后，于 2026-10-17 复核无未解决阻断。实测 scope 的 InvocationID/Description 和 launcher cgroup 关系成立，专属探针单元已清理。
- 当前实现：持久认领/停止 API、原 launcher 的可选接点、新窄测试和 execution 文档；没有个人工具、依赖、打包命令或部署变化。新决定已转 implemented，归档笔记未改。
- 下一动作：总工单实施者接入独立 worker 准备、durable 命令权限/回执/未知暂停与工作占用。当前 API 接收已准备的输入，不假装解决旧 worker 的 Pi 依赖发现；正式入口与部署保持原装配。
- 阻塞：无新的产品取舍；Linux 真实 bwrap、独立停止及后台 SIGKILL 恢复已执行。完全访问、MCP、模型/IM和完整迁移继续后续。

## 验收与证据

- 本机 macOS 27.0.1 / Node 24.15.0 / npm 11.12.1：`npm run setup`、`npm run build` 与最终 `npm run check:static` 通过；P2 修复后原生三文件 31/31、产品入口 17/17（未受 P2 影响，沿用）。原始日志与[内容快照](../evidence/22-macos/source-manifest.json)区分基线、增量和最终内容，不累加重叠用例。末轮只补文档与工单记账，另执行 docs 检查。
- Linux 6.8.0-117 / Node 24.21.0：P2 修复后最小独立源码副本用 `node --experimental-transform-types --test test/native-linux-identity.test.ts test/101-native-linux-scope.test.ts` 执行 26/26，并复跑两真实场景；这些模块只有 Node 内置运行依赖，本次未安装 npm 或执行 Linux 全产品构建。[源码核对](../evidence/22-linux/source-comparison.json)确认两处生产文件及最终两测试与本机一致。
- [真实 OS 结果](../evidence/22-linux/real.log)：真实 bwrap/user scope 中运行 Python setsid 后代，另一进程分别在后台存活及 SIGKILL 后按原引用停止，两个场景均证明心跳冻结、同键拒绝、重复停止可核实；不是命令桩或模型替身。每项 fixture 在证明停止后删除，最终本次残留进程与 fixture 为零。该结果不证明命令外部效果、完全访问或远端 MCP。
- 独立实现审查首轮 `next_slice` 亲跑既有 scope 3/3；隔离副本的 InvocationID/inode 基线 2/2。分别删除两项核实后，对应测试各预期失败，捕获错误 cgroup.kill 写入；共享生产文件哈希前后一致，反证副本已清理。
- 原失败保留：首次本机窄测试把轮询重复停止误断言为一次，改用可控时间后通过；首轮静态因新笔记尚在 proposed 而源码引用 implemented 失败，落地迁移笔记后通过。首次 Linux 真实探针因夹具字符串未转义导致心跳超时，仅修夹具后通过，[初始日志](../evidence/22-linux/real-initial-failure.log)和初始源码 tar 保留；该次夹具修正未改生产实现。
- 独立终审发现并复现 P2：前置失败后未派发证明写入再 EIO，裸错误越层且遮蔽原失败。已保留两次原因并返回 `ExecutionError`，缺证明时停止保持 false；最窄回归及两端最终检查通过。独立复核后无未解决阻断，见[终审记录](../evidence/22-macos/final-review.md)。初始源码 tar 对应修复前，最终 tar/快照对应修复后，不混用。

- 同 ID 并发/恢复至多一次启动；异机器、坏认领与可写/可见认领目录拒绝；认领写失败零启动。
- 覆盖停止先手、认领后派发前、派发后记录丢失、原 launcher 退出但后代仍活、scope 未见即消失、同名单元占用/重建、cgroup 变化、查询/停止失败及跨 boot。错误单元身份与未观察分支零停止信号；停止未核实不删除现场，重复重核可转为已退出。
- Linux 真实 bwrap/user scope 运行心跳及 setsid 后代，SIGKILL 调用后台后由新进程按原引用停止，核对心跳冻结、原 cgroup 退出与无残留。区分真实 OS 与命令桩。
- 本机 `npm run check:static`、`npm run build` 及新窄测试、101 原生策略/scope 回归；Linux 执行相同相关集合。独立审查亲验最小检查及关键失败负例。
- 工程验收：通过。产品验收：不适用，本片无新增人机交互；durable 工具、完全访问、真实模型/IM及完整迁移保持待验。拥有者已授权本次提交，未授权推送或部署。

## Comments

2026-10-17：拥有者指示接手总工单；本片先补可恢复的原生执行身份，避免以进程消失或单元 not-found 冒充全部停止。

2026-10-17：完成本片及独立终审，修复未派发证据写入的 P2 并补回归。本机 31 项原生与 17 项产品入口通过，Linux 26 项及两真实场景通过；总迁移继续 in-progress，未提交或部署。

2026-10-17：拥有者指示提交本片；提交前逐项核对本机 9 文件、Linux 4 文件及最终归档均与已验快照一致，清理证明完整。仅更新提交交接记账，沿用工程结论；未推送或部署。
