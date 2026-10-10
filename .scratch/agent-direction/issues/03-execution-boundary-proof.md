Status: resolved

# 03 — 验证开发机执行权限的技术边界

**What to build:** 用可复跑的最小原型验证 macOS 可用的受限执行方式，并复核 Linux 现有路径，为产品接入提供实际证据。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 实际演示授权工作目录内读取、修改和运行检查，同时拒绝未授权文件、网络与控制面授权材料访问。
- [x] 验证子进程不能绕过边界；停止操作能回收实际执行进程，不能只终止界面。
- [x] 明确受限模式与完全访问模式各自的系统身份、控制面保护和前置条件；完全访问不能伪造拥有者身份。
- [x] 记录验证环境、可行方式、限制和复跑步骤；没有可行方式时如实记录阻塞，不能把 local 无隔离路径当作验证通过。
- [x] 复用现有 Linux 后端开展检查，避免重复建设已经交付的容器和执行账户机制。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：验证完成

**判定结论**

1. **macOS 受限执行的可行方式 = 复用现有容器启动器（Docker Desktop 的 Linux VM）。** 用产品真实路径（`createContainerLauncher` + `ruukoto-worker:0.85.1` 镜像 + 宿主 `ToolWorkerHost`）实际演示：工作区内读（按宿主绝对路径 read）/写（写入宿主可见）/运行检查（bash 与 node）；拒绝工作区外宿主真实文件（拒绝原因是未挂载的边界而非目标不存在）、拒绝外网出口（NETERR ENETUNREACH）与宿主回环控制面端口（linux:probes 覆盖回环与网关两路）；只读授予路径可读不可写；只读根文件系统、CapEff 清零、非 root uid 1000。16/16，`/var/folders` 与 `/Users` 两种工作区路径各跑一遍通过。
2. **macOS 内置 sandbox-exec 不作为受限执行方式**（否决依据，可复跑）：`file-read*`（literal/subpath/regex/`file*`）与 `file-write*` 拒绝规则在本机 **0/6 静默未执行**——deny 后秘密文件仍可读可写；网络拒绝实际生效（curl 解析即被拒）且孙进程继承。规则静默失效比“不支持”更危险：把文件边界建在它会构成假边界。取证脚本 `.scratch/agent-direction/macos-sbx-probe.sh`（0=探针完成、逐条 PASS/FAIL；2=基础设施缺失）。
3. **Linux 现有路径复核通过，无重复建设**：当前代码的 linux:probes 在 macOS Docker Desktop 32/32、tx 原生 Linux 32/32（0 不一致 0 缺失）；机制文件（`launchers.ts`、`deploy/systemd/*`、`deploy/worker-image/*`、工 worker 宿主与探针脚本）与 2026-09-26 已验证部署快照哈希逐字节一致；`worker.ts` 的差异仅为 write 工具编辑统计展示（diff 逐行核对），不改边界语义。tx 部署盘点：`ruukoto-backend` active；生效配置 `RUUKOTO_EXEC_UID/GID=986`（drop-in 覆盖主单元默认 1002，与 `ruukoto-exec:x:986` 一致）、`RUUKOTO_CONTAINER_UID/GID=1003`（拥有者 uid）；受保护提权入口两份 root 0700 脚本在位；`owner.token` 0600 属 ruukoto-backend。为不影响在线的个人 Agent 后台，本单未向其提交任务；完整完全访问端到端结论沿用 2026-09-26 实测（deploy/systemd README 验证状态），本单只复核机制与配置未漂移。
4. **两种模式的系统身份、控制面保护与前置条件已明确**（见下节）；“完全访问不能伪造拥有者身份”给出负向实证：本机 `~/.ruukoto/control/owner.token`（0600 owner，65 字节）对同 uid 任意进程 `test -r` 退出 0——完全访问若以拥有者 uid 运行即持有控制面拥有者身份（取证未读取令牌内容）。macOS 完全访问所需的本机独立执行账户与 sudo 包装属拥有者部署前置，**本机尚未验证，如实记录，不视为通过**。

**开发机三种系统身份（接入工单 04 的依据）**

- **受限模式（confirm/auto-review，容器边界）**：系统身份 = 容器 uid（默认 1000；原生 Linux 按部署经 `RUUKOTO_CONTAINER_UID/GID` 固定为宿主拥有者 uid——原生 bind mount 不做 uid 映射，uid 必须能写工作区；macOS Docker Desktop 由 VM 代管挂载权限）。控制面保护：socket/令牌/凭据均不挂载入容器；宿主只绑回环的控制面端口容器不可达。前置条件：容器运行时安装并运行、工作区位于运行时文件共享范围（Docker Desktop 默认含 /Users、/private、/tmp）、镜像由可信身份构建。缺失时启动器 `execution_unavailable` 明确失败、不回退（既有 test/22 覆盖构造期与启动期失败），符合“拒绝启动受限任务、不静默降级”。
- **完全访问**：系统身份 = 专用执行账户（Linux：ruukoto-exec 经 systemd 单元，已验证；macOS：本机独立账户经 sudo 固定参数包装，属同一类机制，待部署）。提供的是执行账户已有权限——不承诺拥有者账户全部文件，不提供账户内文件隔离（沿用 ADR 0004 既有表述）。控制面保护：执行账户读不到拥有者/后台的控制面材料（内核 uid×0600 边界，Linux 身份探针与真实任务已验证）；不能调用受保护提权入口（root 0700 + sudoers 只放行固定参数）。前置条件：创建执行账户与 sudoers 条目（macOS 待拥有者执行，Linux json-deploy 步骤 4 已完成）。
- **拥有者**：仅可信入口持令牌副本；`RUUKOTO_OWNER_TOKEN*` 是两产品共用的控制面身份（runtime.md 已注明）。

**可行方式与限制（如实记录）**

- Docker Desktop 语义差异：挂载权限由 VM 代管（容器 uid 1000 写挂载工作区不受宿主权限位约束——原生 Linux 无此映射）；性能与 fs 事件语义以 VM 为准，不构成边界差异。
- podman machine 路径（同形状 VM 容器运行时）本机未验证：`podman machine list` 为空；launcher 的 `dockerPath` 可指向 podman CLI，需要时按本单同一冒烟验证。
- macOS 完全访问账户未建：阻塞项如实记录（需要拥有者 sudo 创建账户与 sudoers），不作为通过；local 无隔离后端在本单不作为任何验证依据。
- `verification/foundation/scripts/linux-isolation/container-worker-smoke.mts` 本次扩展证据（复用同一冒烟，未另起脚本）：逃逸孙进程实际运行（心跳对照 0→4）；停止操作回收逃逸孙进程（停止确认后心跳冻结 7→7、心跳文件未被删、docker inspect 确认容器移除）；并收紧「工作区外文件不可见」的断言为「路径不存在（未挂载）而非权限拒绝」。

**验证环境**

- macOS：27.0 (arm64)，Darwin 27.0.0，Docker Desktop 引擎 29.8.0（Linux VM aarch64，linuxkit 7.0.12），镜像 `ruukoto-worker:0.85.1`。
- tx：Ubuntu 24.04，内核 6.8.0-117-generic，Docker 29.5.2，systemd 255，镜像 `ruukoto-worker:0.85.1`。

**复跑步骤**

- 产品级冒烟：`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`（需 docker + ruukoto-worker 镜像；`TMPDIR=<目录>` 可换工作区位置）。
- 容器边界探针：`npm run linux:probes`（verification/foundation 内；报告落 `results/linux-isolation-report.{json,md}`，tx 原生结果存 `-tx` 后缀——目标机上须把两个脚本放进 `.../scripts/linux-isolation/` 目录结构再跑，报告路径为 `../../results`）。
- sandbox-exec 取证：`bash .scratch/agent-direction/macos-sbx-probe.sh`。
- tx 部署盘点（只读）：`systemctl show ruukoto-backend -p Environment`、`systemctl cat ruukoto-backend`（确认 drop-in）、`getent passwd ruukoto-exec`、`ls -l /usr/local/libexec/ruukoto/ /var/lib/ruukoto/control/owner.token`、机制文件 sha256sum 对照。

**模拟与真实环境分列**

- 本单全部边界证据为真实环境：真实容器引擎/镜像/进程/文件/网络/权限位；冒烟不发生模型调用，无模拟件。登录项：`container-worker-smoke.mts` 16/16（mac，两种工作区路径各一遍）、linux:probes 32/32 ×2（mac 的 Docker VM 与 tx 原生 Linux）、`macos-sbx-probe.sh` 一次（文件规则 0/6 未执行，网络拒绝与孙进程继承 2/2 生效、宿主对照通过）、tx 盘点一致。
- 仓库验证：`npx tsc --noEmit` 通过；`npx tsx --test test/67-visual-docs.test.ts` 通过（3/3）；全量 `npm test` 712 项：709 通过、1 跳过、仅 main 上既有 2 项失败（13-tui-state accessModeLabel、19-tui-demo usage 事件覆盖，与本单无关，干净 HEAD 可复现，issue 01/02 已记录），本单改动无新增失败。
- 文档同步：`docs/runtime.md`（ruukoto-code 行为差别：验证结论替换“尚在验证”；验证状态诚实清单新增 5 行）、`docs/visual/deployment.html`（边界总图补开发机对照段）。

**与验收标准对应**

1. 授权目录内读写与运行、目录外/网络/控制面材料拒绝 → 冒烟第 1/2/3/4/6 节 + 探针 hostfs/control-plane 项（真实演示）。
2. 子进程不绕边界、停止回收实际执行进程 → 冒烟第 5 节（逃逸孙进程运行对照 + 停止冻结 + 容器移除核实）。
3. 两模式身份/保护/前置明确、完全访问不可伪造拥有者 → 身份小节 + 负向实证（未验证项单列）。
4. 环境/方式/限制/复跑步骤全录；sandbox-exec 否定与 macOS 完全访问账户未验证均如实记录；local 未计入任何通过项。
5. Linux 复用既有探针与部署开展复核，从零建设的只有 5 行冒烟扩展与 1 个取证脚本。
6. 端到端（冒烟+探针）、tsc、test/67、全量 npm test 完成；runtime.md 与 deployment.html 已同步；模拟/真实分列见上。

### 2026-10-08：Seatbelt 文件规则结论更正（工单 26 第一阶段）

保留上面的 2026-10-02 历史记录，但撤回其中“文件规则静默不执行，所以 Seatbelt 不构成文件边界”的判断。旧脚本在 `/tmp` 建资料并直接用该字串生成 literal/subpath/regex 规则；本机真实路径为 `/private/tmp`，规则未匹配目标。规范化路径后，文件拒绝生效。旧脚本还把任意非零退出当作拒绝、用非空 stderr 判子进程拒绝，并在边界失败时退出 0；这些判定已更正。

旧入口 `bash .scratch/agent-direction/macos-sbx-probe.sh` 现在复用新的真实 macOS 探针。探针先验证未沙箱对照，再用 started 标记与实际操作的 errno 区分策略解析或程序启动失败、真实拒绝和未被拒绝；退出码 0 表示被测项通过，1 表示边界失败，2 表示基础设施或判定缺失。所有材料、监听服务和目标进程均由探针临时创建，不读取真实凭据。

这项更正只确认 Seatbelt 文件机制可用。工单 26 的完整原生替换仍未通过第一阶段：`posix_spawn` 可以绕过 `SYS_setsid/SYS_setpgid` 拒绝规则，让后代脱离原进程组；可信宿主杀原组后，后代心跳继续增长。`kqueue NOTE_TRACK` 实测为 `ENOTSUP`。临时 launchd job 的 `bootout` 成功与 job 消失同样不能证明后代停止。可复跑脚本与完整证据见[工单 26](26-native-sandbox.md)。容器的已有实测结果继续作为容器边界证据，不能据此替原生边界验收。
