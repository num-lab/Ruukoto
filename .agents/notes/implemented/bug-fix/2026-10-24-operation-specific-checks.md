# Agent Note: 按实际操作和访问模式核实范围

Status: implemented

## 问题

拥有者浏览解除保护目录检查后，审查仍发现三个同类问题：Git 查询遍历所有元数据并拒绝正常克隆及配置引用；个人网络与完全访问操作因无关资料目录失效而失败，后台监督反复扫描保护树；工作区登记不论模式都扫描保护树并拒绝后台资料及其祖先。拥有者要求先修这三项。

## 决定

拥有者 Git 查询沿 Git 能解释的链接、硬链接对象、alternates 与配置 include 读取，不枚举整棵元数据树。保持固定参数与环境，禁用 hooks、pager、签名命令、fsmonitor、自动维护和 lazy fetch；日志固定 UTF-8。指针文件按最终普通文件句柄有界读取并核实稳定性，Git/common 目录身份与 HEAD、refs、remote、shallow、grafts 的前后摘要继续生效；HEAD 为符号链接时把原链接文本纳入修订。对象库按 Git 的 OID 不变语义使用，等价对象库换位置不改变历史；不承诺修复人为损坏的对象。

个人 HTTP 与 Web Search 核实来源、配置、权限、凭据及未决效果，不核实无关文件目录。完全访问绝对文件读写只核实实际目标；文件检索仍核实逻辑 cwd、目标目录、执行指纹及权限，但完全访问不扫描保护树。受限文件调用、资料授权和配置保存继续原范围检查。

个人命令接纳、准备、开始意图及会话后台监督按原工作固定的模式校验。完全访问仅保留 Linux、目录身份、machineId、TMPDIR、来源及停止事实，不做保护扫描；受限命令沿原生沙箱继续限制范围。`readPersonalCommands`、`savePersonalCommands` 与 `personalCommandEnvironment` 的共享配置校验保持默认受限，后台专属装配则按其唯一支持的完全访问校验。500ms 监督周期和失效后停止规则不变。

工作区、新会话、分支及组织迁移只登记真实有效目录，不因 Agent 保护根拒绝登记；登记不授予任务执行权限。native 在实际启动前核对范围，Runtime 的库层受限 local 入口在 `launch(spec)` 前批量核对 workspace、grants 与 readRoots；完全访问直接沿原启动器。local 仍不提供 OS 隔离。模式切换停止旧 worker 并重新取得按任务模式选择的启动器，prepared 分支恢复沿同一目录身份规则。

## 既有决定

检索 Git、保护根、工作区、个人资料与命令检查。部分取代[拥有者浏览](../feature/2026-10-24-owner-workspace-browsing.md)保留的 Git 元数据限制与工作区登记规则、[Git 接线](../architecture/2026-10-17-desktop-demo-v4.md)及[分页](../feature/2026-10-17-desktop-git-history-pages.md)的整树预检、[访问模式](../feature/2026-09-19-explicit-access-modes.md)的登记限制。补充[完全访问](../feature/2026-10-12-full-access-current-account.md)的同账户语义，部分取代[个人工具](../architecture/2026-10-17-personal-tools-access-artifacts.md)、[命令配置](../architecture/2026-10-17-personal-command-configuration.md)、[完全访问命令](../architecture/2026-10-17-personal-full-access-commands.md)和[会话后台](../feature/2026-10-21-personal-background-processes.md)的运行时无条件保护扫描。原生沙箱、资料授权、未知效果与停止证据保持；技能、文件预览链接、目录分页和界面预取命中不属本轮。

## 备选方案

- 缓存保护树或移至线程：可以减少等待，但保留错误的操作依赖和拒绝规则，且增加失效或线程生命周期，优先删除不适用的检查。
- 按新会话默认模式决定登记资格：改动较少，但默认模式可后改，分支和迁移也不等于执行；登记与真正启动分别核实。
- 一并删除所有目录核实：实现更少，却丢掉实际目标、来源和受限执行保证；只移除无关目录与不适用的保护检查。
- 追踪 Git 所有外部引用文件：可使任意配置变化都淘汰游标，但再次引入全树扫描；按 Git 实际解释的历史事实形成摘要，并固定影响输出的编码。

## 后果

正常 Git 克隆和共享仓库可以浏览，查询成本不再随无关元数据增长；网络与完全访问操作不再被无关资料目录牵连，登记无需保护树扫描。受限执行仍可能拒绝已经登记的目录，需要拥有者选择合适的任务模式。冷配置仍有原校验成本，Git 输出及分页预算保持，本轮不改变目录 200 项限制或文件预览链接规则。

回归覆盖旧代码失败、新代码通过、Git 配置不执行程序、真实工具切模式与 prepared 分支恢复、个人网络和命令零保护扫描及目录失效停止。定向测试、独立审查和 Linux 验证范围见[工单](../../../../.scratch/owner-operation-scope/issues/01-remove-unrelated-checks.md)。
