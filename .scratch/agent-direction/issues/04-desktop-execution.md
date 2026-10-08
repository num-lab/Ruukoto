Status: resolved

# 04 — 在开发机完成受限和完全访问任务

**What to build:** 把已验证的执行方式接入实际开发任务，macOS/Linux 均可完成一次代码修改和检查，并由拥有者明确选择权限模式。

**Blocked by:** [03 — 验证开发机执行权限的技术边界](03-execution-boundary-proof.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 真实工具执行使用已验证的系统边界，能完成授权目录内的代码修改与检查。
- [x] 越界操作遵循审批规则，子进程与实际文件、网络访问也受约束，不能仅检查工具参数。
- [x] 完全访问由拥有者显式选择，使用已定义的执行身份，不获得控制面授权材料。
- [x] 受限后端缺失或失效时在执行前拒绝，不静默回退到普通账户执行；停止和异常中断沿用未知效果规则。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：接入完成

**判定与改动（依据工单 03 的验证结论）**

1. **ruukoto-code 默认执行后端 local → container**（`src/cli.ts:runServer`）：受限任务默认在工单 03 验证的每任务容器边界内执行，不再「以 local 运行并打印提示」。`--execution local` / `RUUKOTO_EXECUTION_BACKEND=local` 仍可显式选择，两产品以 local 生效时打印同一条无隔离警告；ruukoto（个人 Agent）默认不变。按需拉起的后台不传 `--execution`，沿用产品默认。受限后端缺失（docker 不可用）时的拒绝点在工具工作进程启动：任务可入队（提交时容器路径无法预知 docker 是否失效），首个工具调用以 `execution_unavailable` 拒绝、命令不执行、不回退——这是工单 03 已定的边界判例（「既有 test/22/07 覆盖构造期与启动期失败」），本单把默认后端切到 container 后 test/07 既有用例继续证明该路径。完全访问则如 ADR 0003/0004 要求在提交前拒绝（任务不创建）。
2. **修复工作进程启动窗口的中断竞争**（冒烟发现的真 bug）：工具意图落库早于工作进程 ready，此窗口内的中断看到空受管登记表，`abort()` 等待一个无人停止的工具调用——中断挂死到工具自然结束（test/07 旧行为 20s+ 超时复现，本地后端的 sleep 30 任务同样命中）。修复：ready 前以 `starting` 占位登记受管单元（`tool-router.ts` 的 ensureWorker + `managed-processes.ts` 的 ManagedUnitKind 增第四取值），停止时等启动落定后按对应种类回收；`driver.killManagedProcesses` 读表前让出一个宏任务，使已记录意图的派发先完成登记。
3. 权限模式选择沿用既有机制：完全访问只能经拥有者显式入口（submit `--mode`、`switch-mode`、TUI `/mode`）选择；完全访问什么环境下都不进容器（`createSystemdLauncher` 固定执行账户，执行身份拿不到控制面材料——Linux 2026-09-26 实测在用身份读不到 owner.token，本单沿用该结论，部署配置 2026-10-02 工单 03 复核未漂移）。

**验证（真实环境与模拟分列）**

- **产品级冒烟** `.scratch/agent-direction/smoke-04-desktop-execution.mts`（模型打桩；容器/镜像/文件/网络/审批全真，0 全过、2 基础设施缺失）：
  - macOS 本机（Docker Desktop 4.x/29.8.0，镜像 ruukoto-worker:0.85.1 = :latest，uid 1000）：**6/6**——容器内完成代码修改（read/edit/bash 驱动的 sum.mjs 修复）与检查（check.mjs 修复前失败、修复后通过，改动宿主可见）；容器内外网出口失败、未挂载宿主真实文件不可见、只读根拒绝写入、工作区写入宿主可见；越界读取走 request_file_access 审批、批准单次消费并按批准参数执行；完全访问缺执行账户入口时提交即 `execution_unavailable` 且报「不回退」；中断回收执行单元（docker ps 确认容器移除），含启动窗口。
  - tx（Ubuntu 24.04，内核 6.8.0-117，Docker 29.5.2，仓库同步到 `~/ruukoto-issue04` 复用 /opt/ruukoto 的 linux node_modules，容器 uid/gid 1003 = 工作区属主）：**6/6**。完全访问身份未复跑：线上部署（2026-09-26 已验证、当日报盘未漂移）的 sudoers 只放行 ruukoto-backend，另一后台进程借用会越权，未向运行中的个人 Agent 侧面验证，如实记录；macOS 完全访问账户仍属部署前置、未验证。
- **离线测试**：test/73-desktop-execution.test.ts（进程级，4/4：dev 默认 container、显式 local 告警、env 覆盖、完全访问执行前拒绝、confirm 照常、非法取值拒绝）；test/07 新增「工作进程启动窗口的中断」（红→绿，5/5）；受影响回归 test/02/03/04/63/64/71/72 全过；`npx tsc --noEmit` 通过；test/67-visual-docs 3/3。
- **全量 `npm test` 717 项：713 通过、1 跳过、3 失败均为既有/环境问题，与本单无关**——13-tui-state accessModeLabel、19-tui-demo 合成会话覆盖（工单 03 记录的既有失败）；08-approvals「DNS 在批准时固定」（60s 超时）在本机干净 HEAD 上同样复现（本机 DNS 环境性地超时）；30-workspace-entry「多项目选择取消后回落」曾单发超时（干净 HEAD 同时段同样出现、本轮已通过），按环境抖动如实记录。

**复跑步骤**

- 产品级冒烟：`npx tsx .scratch/agent-direction/smoke-04-desktop-execution.mts`（需 docker + ruukoto-worker 镜像；`TMPDIR` 换工作区位置；原生 Linux 容器 uid/gid 默认取当前进程、`RUUKOTO_CONTAINER_UID/GID` 可覆盖）。
- 离线：`npx tsx --test test/73-desktop-execution.test.ts test/07-real-tools.test.ts`；全量 `npm test`。

**同步**：`docs/runtime.md`（ruukoto-code 行为差别、按需拉起默认值、验证状态表）、`docs/visual/deployment.html`（产品默认后端、`starting` 取值、工单 04 接入说明）、`docs/visual/task-lifecycle.html`（停止路径补启动窗口与占位登记说明）。

**与验收标准对应**

1. 真实工具执行在容器边界内完成代码修改+检查 → 冒烟前两节（mac/Linux 各 6/6）。
2. 越界按审批执行 + 子进程/真实文件/网络受系统级约束 → 冒烟第 2/3 节（参数外的容器层证据）；审批单次消费沿用既有审批闸门。
3. 完全访问显式选择、固定执行账户、不持控制面材料 → 既有机制 + Linux 实测沿用；mac 未部署入口拒绝（冒烟第 4 节），账户未验证如实单列。
4. 后端缺失/失效执行前拒绝、不回退 → test/73 + test/07 既有「执行入口不可用」用例；停止与中断规则 → 启动窗口竞争修复（test/07 回归）+ 冒烟第 5 节。
5. 端到端/类型检查/仓库验证、模拟与真实分列 → 上节。
