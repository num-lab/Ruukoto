Status: ready-for-agent

# 01 — 将 ruukoto 的受限执行迁到原生沙盒并移除 Docker worker

交付目标见[已确认规格](../spec.md)，理由与被否方案见[决策提案](../../../.agents/notes/proposed/architecture/2026-10-12-personal-native-sandbox.md)。本单实施尚未开始；状态表示规格可执行，不表示平台或产品验收已经通过。

Blocked by: 无未完成工单。[原生沙盒 26](../../agent-direction/issues/26-native-sandbox.md)、[停止未核实保留 27](../../agent-direction/issues/27-preserve-unverified-worker-stop.md)、[当前账户完全访问](../../full-access/issues/01-full-access-current-account.md)与[通用调度](../../generic-scheduler/issues/01-generic-scheduled-tasks.md)均已完成，是可复用基础。第一阶段的服务器常驻验证是切换产品默认值的前置。

## 已核实事实

| 位置 | 当前行为与需要覆盖的变化 |
| --- | --- |
| `apps/ruukoto/src/product.ts`、`packages/tui/src/cli.ts` | 个人产品默认 local，未声明 allowedExecution 时正式入口只接受 local/container；不能仅把生产环境变量改成 native |
| `apps/ruukoto-code/src/product.ts`、`packages/tui/src/dev.ts` | Coding Agent 已默认且只接受 native；开发入口清理继承的执行配置并跟随产品声明，可直接复用能力接线 |
| `packages/agent/src/execution/launchers.ts` | 已有 native 工厂；full_access 总是当前账户 local。Docker launcher、配置读取和枚举仍在此 |
| `packages/runtime/src/runtime.ts`、`packages/agent/src/tool-router.ts` | 普通 worker、SubAgent、worktree 创建及汇总已走同一 launcher；容器 UID/GID 预检与 macOS Docker inode 例外需要随删除清理 |
| `packages/agent/src/tool-availability.ts`、`packages/runtime/src/subagents.ts` | main/独立定时根任务使用业务工具和委派能力，编码任务沿实际父任务模式进入 worker；不能给根任务加 bash 代替验证委派链 |
| `deploy/systemd/ruukoto-backend.service`、`packages/agent/src/execution/native-linux.ts` | 后台是指定账户的系统服务，模板显式 container；native 依赖 user systemd、XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS、Delegate=yes 和可写 cgroup.kill |
| `deploy/worker-image/`、`package.json` | 镜像提供 Node 24、bash/coreutils/Git；原生改用宿主工具。build:worker-image、test:docker 和旧 linux:probes 仍指向容器流程 |
| `packages/agent/src/execution/native.ts` | 原生每单元有宿主临时目录，无 64 MiB 上限；停止核实后才清理。对授权树的硬链接检查有随目录规模增长的成本 |

## 实施计划

四阶段顺序执行；各阶段先完成自己的证据，再推进依赖它的阶段。实现尽量复用现有入口、探针与 smoke，不增加第二套执行或审批框架。

### 1. 证明 Linux 常驻后台可以使用现有原生边界

- 在 `ssh tx` 的隔离检出、临时档案和独立服务单元中验证；以服务实际账户运行 worker，避免用交互 shell 的环境替代 systemd 环境。不修改在线个人实例，不使用会覆盖生产路径的历史服务 smoke。
- 保留现有系统级 backend service 作为首选部署方式。为运行账户交付 user manager 的开机及退出登录存活配置（如 linger）、准确的 runtime dir/user bus 环境和必要的启动顺序；安装步骤显式配置，不由任务 launcher 自动提权或改变系统策略。
- 复用 `deploy/native/` 的正式 `/usr/bin/bwrap` 与按路径 AppArmor profile，核实 cgroup v2、完整 namespace、scope 委派及 cgroup.kill 可写。保留整机 userns 加固，不给 bwrap 加 setuid。
- 从系统服务启动真实原生 worker，验证正常停止、启动中取消、脱离进程组后代、后台被强杀和服务重启。用真实心跳或持续写入及 scope/cgroup 状态核实后代，不把 backend service 的 KillMode 或主 PID 退出当作充分证据。
- 验证目标账户无交互登录时的冷启动、退出登录后的定时唤起和重启后的运行。整机重启只能在适合重启的隔离环境中演练；若当前服务器不能满足，不将重启项记通过，补充可重启环境后完成。
- 若共享 native 在此部署方式下暴露缺口，在原持有者修复并增加针对失败结果的小测试；不能靠 fallback、放宽保护根或清掉占用推进。若必须改变已确认的部署方向，先补充事实并修订提案。

阶段出口：可复跑的部署步骤、环境元数据和真实结果证明常驻前提成立；缺项和拒绝路径有明确诊断。本阶段通过前不切换产品默认。

### 2. 接齐个人产品入口与全部受限执行路径

- `apps/ruukoto/src/product.ts` 声明 defaultExecution 为 native、allowedExecution 仅 native；CLI、显式 server、`npm run dev`、后端展示与配置校验跟随能力声明。共享包不按产品名加分支；个人产品继续显式启动后台。
- 正式入口拒绝 container/local 参数及 `RUUKOTO_EXECUTION_BACKEND` 覆盖，并提供移除覆盖或改 native 的指引。库层 local 继续用于完全访问与测试，不能成为正式受限执行入口。
- 沿 ToolRouter、Runtime、SubAgent 与 WorkCopyManager 核对每个调用点，保留工作区/授予 dev/ino、只读共享 Git、保护根、硬链接校验和受管单元登记。临时 Git 操作仍在 worker 中执行。
- 用个人产品身份覆盖普通开发任务、main 委派、独立定时会话委派及协作后续任务。模式来自实际任务或已登记的调度计划；请求确认、自动审查和计划模式使用受限边界，完全访问继续当前账户执行。
- 保持审批参数固定和单次消费；失败使用现有 ExecutionError/code/reason。授权变化先停旧环境，停止未核实保留占用并拒绝替代；重启的效果未知操作不自动重放。

阶段出口：无 Docker 时，正式个人入口及上述调用点均能使用 native，旧参数拒绝、权限收窄、停止失败和完全访问分流有回归证据。

### 3. 删除 Docker worker 及其专属交付路径

- 删除 createContainerLauncher、镜像和 Docker CLI 配置、container 后端取值，以及无调用者的容器 UID/GID 预检、VM inode 例外、展示与 fixtures。沿类型导出、包 exports、控制面执行信息和受管单元类别检查所有调用者；保留 native/service 使用的 systemd_unit 及 full_access 使用的 local。
- 删除 `deploy/worker-image/` 与 build:worker-image；移除后台模板的镜像、Docker 组和容器 UID/GID 要求。保留 build:worker 及其真实 SDK 运行依赖，核实宿主 Node、Git、Bash 等运行工具，不为兼容未知工具布局放开整个目录。
- 处理 `test:docker`、`linux:probes`、`verification/smoke/gate.ts` 和基础验证中的活跃容器入口。复用或调整现有 native 前提检查，给迁移后的场景提供与内容一致的可运行命令；旧容器探针转为明确历史材料或删除，不能让活跃命令继续暗依赖 Docker。
- 将 smoke 04/13/15/18 的修改与审批、协作、恢复、原 IM 入口汇报场景迁到 native；同步 smoke-24 的升级后个人后台（目前仍用 local）及新旧配置迁移断言。模型与平台替身继续明确标注。
- 仓库搜索验证剩余 Docker/container 引用逐项有归属：历史证据或独立服务防护可以保留；无调用者的 worker 专属分支与失效文档不能保留为隐藏后端。不得清理服务器上的其他容器或以全局 prune 处理旧 worker。

阶段出口：两个产品的新执行与活跃交付检查不需要 Docker，原有有价值的行为场景仍受验证；历史报告不被改写成 native 结果。

### 4. 完成验证、迁移说明与交付

- 更新 `README.md`、`docs/usage.md`、`docs/development.md`、`docs/modules/execution.md`、`docs/modules/deploy.md`、`docs/modules/runtime.md`、受影响的 `deploy/systemd/README.md`、`deploy/native/README.md` 与 `verification/smoke/README.md`。人类文档只描述交付后的实际行为，当前规划阶段不提前改写。
- 升级步骤必须先以旧版本停止后台并按实例核实旧 worker；未核实则保留占用并停止切换。备份原配置和资料，安装宿主工具及原生前置，移除旧覆盖，再用原档案启动并验收。恢复旧版本也先核实新单元停止，不承诺在线无损切换，不删除历史或工作副本。
- 记录 user manager/linger 对账户常驻生命周期的影响，临时目录使用宿主磁盘及未核实时保留的行为，以及宿主工具依赖和权限检查方式。Docker 卸载和既有 docker 组权限清理是独立运维决定，不自动执行。
- 将 proposed 笔记按实际结果转 implemented，添加承载决定的代码锚点；按提案审计表同步被部分取代的事实与互链，保留旧决定和真实历史结果。
- 汇总下表证据及所有验收项，区分真实 OS、产品入口与模拟外部平台。只有完整完成后才把本单改为 resolved；生产实际切换不算本规划会话已经授权执行的工作。

## 验证选择

以下为现有入口和需迁移的验证面，实施时按实际改动选择最小集合，不默认运行全量 npm run check。旧容器专属断言先改为目标契约，不能只为了全绿删掉场景。

| 改动面 | 验证入口 |
| --- | --- |
| 正式与开发入口 | `npx tsx --test test/29-cli-entry.test.ts test/32-dev.test.ts test/71-product-entry.test.ts test/72-on-demand-backend.test.ts test/73-desktop-execution.test.ts` |
| 启动、停止与模式 | `npx tsx --test test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/100-worker-stop.test.ts test/10-access-modes.test.ts`；触及 macOS 监督器时加其定向测试 |
| 工具、审批与 Plan | `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/22-auto-review.test.ts test/58-plan-mode.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts` |
| 个人委派与调度 | `npx tsx --test test/80-subagent-delegation.test.ts test/51-generic-scheduler.test.ts test/86-subagent-messaging.test.ts test/84-im-final-delivery.test.ts` |
| worktree、汇总与恢复 | `npx tsx --test test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/86-subagent-recovery.test.ts test/95-work-copy.test.ts test/91-release-acceptance.test.ts` |
| 真实原生边界 | `python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --bwrap /usr/bin/bwrap`；`npx tsx verification/smoke/smoke-26-native-worker.mts`；`npx tsx verification/smoke/smoke-26-native-worktrees.mts` |
| 个人产品与服务器 | 迁移后的 04/13/15/18 场景、个人调度委派场景、第一阶段系统服务无登录/冷启动/强杀/恢复演练；实际入口和原始结果随实现登记 |
| 双产品与升级 | `npm run test:upgrade`；在 Linux 和 macOS 按共享改动面执行 ruukoto-code 原生回归，保留已有平台限制 |
| 构建及静态契约 | `npm run build`、`npm run check:static`；修改 foundation 入口时加 `npm run test:foundation`；部署模板按实际安装步骤演练，不再要求构建已删除的 worker 镜像 |

模型默认离线。真实 QQ/Telegram、真实模型或真实服务管理如果缺少隔离前提，明确记录未测；它们不能替代或阻塞使用受控替身验证本次执行链，但不能据此声称真实平台外发验收通过。

## 验收清单

- [ ] 个人 CLI/server/dev 默认且仅接受 native；参数、环境、展示一致；container/local 显式覆盖拒绝并给出迁移指引。
- [ ] Docker 不可用时，个人产品普通开发及 main/独立定时委派完成真实 read/edit/write/bash、只读委派、并行 worktree 和成果汇总。
- [ ] 实际服务账户在无人登录、退出登录和可重启隔离环境的开机后仍能启动原生单元；缺 bwrap/profile/user manager/cgroup 能力时明确拒绝。
- [ ] 文件、网络、控制面、环境、FD、只读共享 Git 与授权身份边界通过真实探针；越界批准和模式传播保持原契约。
- [ ] 启动取消、授权变化、普通停止、后台强杀/重启和脱离组后代均有实际结果；停止未核实保留占用/现场，效果未知不重放。
- [ ] Docker worker、专用类型/配置、镜像构建与失效活跃入口已移除；有价值的场景已迁移，历史证据和服务 helper 防护保留。
- [ ] 已验证当前账户完全访问及 ruukoto-code 共享路径回归；原生临时空间无配额的部署说明准确。
- [ ] 升级演练保留历史、审批、产物、工作副本与异常占用；文档、notes、构建和对应检查完成，真实与模拟证据分列。

## Comments

### 2026-10-12：建立工单

拥有者在规格 Q1—Q5 确认范围和计划。调查只读取仓库，未连接服务器、运行平台探针、修改产品代码或部署配置。工单 26/27 的既有通过记录只证明其原范围，不能填入本单验收框。

规划文件校验：首次运行因未安装 tsx 无法启动检查，按仓库要求完成 npm run setup 后，npm run verify-notes、npm run check:docs 与 git diff --check 均通过；未运行应用测试或真实平台验收。
