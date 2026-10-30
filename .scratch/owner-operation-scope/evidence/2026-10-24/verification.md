# 操作检查范围验证

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

基点：`26865864`；验证最终未提交改动，源码与文档快照见 `source-hashes.json`。独立副本仅分工实现，最终代码已汇总；他人的 CI／测试策略改动不在此证据范围。

## 修改前失败与定向回归

- Git：新增正常克隆／include、禁止全树枚举、元数据链接三项在旧代码上全部失败；修改后 `npx tsx --test test/desktop-workspace-git.test.ts` 的 21 项全部通过。覆盖真实 local/shared clone、UTF-8、配置程序不执行、相对和链接指针、HEAD 同 OID 分支切换、include remote 变化、等价对象库、分页与原错误分类。
- 个人操作：新增 5 项在旧代码上全部失败，修改后全部通过；原 full_access 命令热路径扫描 3 次、后台启动及两轮监督扫描 4 次，修改后均为零。8 个相关文件 110 项通过、1 个 Linux 实机用例在 macOS 按平台跳过，原始输出见 `personal-red.log`、`personal-green.log`、`personal-macos.log`。
- 工作区：新增 5 项旧代码全部失败，修改后通过；5 个入口／模式／分支／迁移文件共 91 项通过，另有 native 启动前保护 1 项通过。真实 worker 证明 full_access 可读临时保护文件，运行中切受限后下一次读拒绝且旧 worker 不复用；prepared 分支跨重启恢复后可再次真实读取。命令与副本源码哈希见 `workspace-checks.json`。
- 汇总后 `npm run check:static` 通过，覆盖 lint、workspace／foundation 类型、笔记与文档门禁；`git diff --check` 通过。

## Linux 隔离验证

机器为 `ssh tx`，Node 24.21.0。使用独立目录和当前锁文件安装依赖，不连接日常档案或实际模型／IM。最初磁盘空间不足，已清理本次失败安装；随后在独立 tmpfs 目录安装完成，esbuild 可执行文件单独放在本次临时磁盘目录。验收机缺少 rg，用发行版 ripgrep 14.1.0 包解压到本次临时目录，只为测试扩充 PATH；没有更改系统安装。

运行 `npm run build:worker` 后，个人配置、命令工作、会话后台与工具四文件共 85 项：首次 83 项通过，两项因缺 rg 失败；补齐前提后仅重跑失败的两项，全部通过。首次无跳过项，包含真实 Linux 后台跨轮保留、停止核实、认领释放和重开不重放。平台替身用例仍按替身解释，不把整组都记为实际 OS 执行。

最终 Linux 定向结果：`search-final.log` 两项检索通过；`workspace-final.log` 五项登记、受限 local 启动、真实 worker 切模式、分支恢复与迁移通过；`git-final.log` Git 全部 21 项通过。`linux-command-modes.mts` 直接使用真实 Linux scope 执行 confirm、auto-review、full_access，各返回 `verified`、exit 0 且 exited=true，受限保护根在启动前拒绝，原始结果为 `command-modes.jsonl`。单次命令证据与停止均由实际实现核实。

所有受验源码及测试与主工作树逐文件 SHA-256 一致，见 `linux-source-hashes.json`。验收后已清理本次 Linux 安装、缓存、工具与命令夹具；日常后台未重启。

## 性能与审查

macOS Node 24.15.0，隔离 Runtime 与真实控制 socket，启动时间不计：同一普通目录三轮 `open_workspace(mode=full_access)` 为 0.815、0.614、0.611 ms，`create_session(mode=full_access)` 为 0.562、0.473、0.429 ms。审查阶段旧实现相同入口分别约 426.9、423.3 ms；前后不是同一进程或负载，不作固定延迟保证，回归的关键是登记不调用保护范围及不枚举无关树。

独立代理 `operation_scope_review` 对最终代码亲验 32 项全部通过，另以相对 gitdir／commondir 外部链接夹具对照真实 Git 解析；代码审查无阻断。文档及新旧笔记补审无阻断，新笔记 10 个链接目标均存在且旧决定有回链。新 local 拒绝文本由真实工具回归确认进入模型实际请求；未修改工具 schema 或系统提示。

## 未覆盖项

未使用真实模型、IM 或原生 Desktop 做产品端到端验收，未升级日常实例。文件预览链接、技能重复读取、native 挂载循环、目录分页和 Git 入口预取不属本轮；共享个人配置保存／加载仍保留原保护校验。
