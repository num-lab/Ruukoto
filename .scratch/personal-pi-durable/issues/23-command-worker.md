# 个人命令 worker 与独立运行依赖

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)与[持久执行身份](22-native-execution-identity.md)，完成通用命令接入所需的独立 worker 和启动准备。沿用[规格](../spec.md) A1/A5/A9 及拥有者已确认的范围，不新增产品取舍。本片不开放模型命令工具，不接 durable 工作权限、审批、回执或占用，不切正式入口、完全访问或部署。

## 方案

- `prepareNativeLaunch` 接受宿主显式 `dependencyRoots`：省略时保留 Coding 的 Pi 依赖发现，空数组用于自包含 worker。显式依赖也须真实存在并经过保护根核对，不开放未知父目录。
- `apps/ruukoto/src/personal-command-worker.ts` 是纯 Node 单次入口，只在 stdin 完整关闭后读取一份最多 4 MiB 的 UTF-8 JSON `{ command, workspace: { path, dev, ino } }`；command 必须非空白且不含 NUL，workspace 必须是绝对真实目录和有效 dev/ino，输入类型、编码或身份错误均在 spawn 前拒绝。同时核实进程当前目录的路径与 dev/ino，Bash 继承已有 cwd，不按 payload 路径重新打开目录；运行 `/bin/bash --noprofile --norc -c`。stdout/stderr 原字节直传；Shell 无交互 stdin；退出码原样交给宿主，命令信号映射为 `128 + signal` 退出码，不冒充 worker 自身收到信号。输入、目录和启动失败在 stderr 给出有 code 的诊断，宿主不能按诊断正文判断效果。
- 调用顺序固定为等待 `launchLinuxExecution` 返回，接好 stdout/stderr/exit 消费，再 `stdin.end(payload)`；worker 等待 EOF 避免快速命令在 scope 身份观察前退出，真实 Linux 也覆盖立即退出命令。
- 一次进程只执行一条命令，不复用旧 worker 的 ready/init/工具循环。命令输出及退出状态不是可信的外部效果回执；进程结束不代表后代停止。Linux 受限调用方须用原持久引用核实整 scope，未核实不能释放占用或清理临时资料。
- `build:worker` 同时生成现有 Coding worker 和个人自包含产物，保持旧产物路径。同步 README、development、products、execution、personal-durable 与 pre-push-checks 的实际变化。
- 新窄测试运行复制到无 node_modules 目录的产物，覆盖原字节/大输出、退出码/信号、坏输入与目录替换零执行；原生准备覆盖显式空依赖及保护拒绝。Linux 真实 bwrap/user scope 运行本产物并核实停止；Coding 旧准备与入口定向回归。检查执行 `npm run setup`、`npm run build`、`npm run check:static` 和上述窄测试，不跑全量 check。

理由和备选见[决定](../../../.agents/notes/implemented/architecture/2026-10-17-personal-command-worker.md)。

## 进展与交接

- 当前角色：工程交接；实施、文档与最终材料均已独立复核无阻断；基点 `3c0c8f486fafe4a447b85d1dbf286dd5d5228392`，分支 `Eitrous/migrate-to-pi-durable`，接手时工作区干净。
- 只读调查 `worker_survey` 已确认旧 worker 的 Pi 0.85.1 与整个 node_modules 发现，以及旧 Host 的取消不等于持久停止证明。
- 当前内容：拥有者已授权本次提交，由本次提交承载实现与证据；12 个源码/测试/说明文件的 SHA-256 及完整内容见[本机快照](../evidence/23-macos/source-manifest.json)与[归档](../evidence/23-macos/source-final.tar.gz)。工单记账不在源码快照中。Linux 生产/探针快照及 11 项对照由[Linux 材料](../evidence/23-linux/README.md)持有；个人产物最终哈希 `c1d8bc3492be8253ce5bdf4ed5dc553e44da91fc3eda4be663eddd7d49e63cf3` 与独立审查一致。
- 下一动作：总工单实施者将本产物接到原工作权限、操作回执、未知暂停和持久停止占用；保存原临时目录与执行引用，任何内存句柄丢失也按原引用核实停止。不能把本片记为 durable 命令工具或完整迁移通过。
- 阻塞：本片无未解决阻断。真实模型/IM、完全访问和完整迁移继续后续。

## 验收与证据

- 独立方案审查：`worker_survey` 于 2026-10-17 直接核对规格、前片与源码，补齐坏输入零启动、继承 cwd 及 launch 后提交输入时序后复核通过，无未解决阻断。该次仅审方案，不覆盖实现或运行测试。
- 本机 macOS / Node 24.15.0：`npm run setup`、最终 `npm run build` 与 `npm run check:static` 通过。定向五文件首轮 53/53；独立审查修复后对唯一受影响的个人 worker 文件最终复跑 5/5，其余 48 项内容未变，合并覆盖 53 个唯一场景，不累加重叠计数。[首轮日志](../evidence/23-macos/tests-before-review-fix.log)、[最终窄日志](../evidence/23-macos/tests-final-worker.log)、[构建](../evidence/23-macos/build-final.log)、[最终静态](../evidence/23-macos/static-final.log)保留实际输出。
- Linux tx / Linux 6.8.0-117 x64 / Node 24.21.0 / bwrap 0.9.0 / systemd 255：真实 prepare 使用 `dependencyRoots: []`，没有仓库 node_modules；原宿主 npm 工具链仍保留。最终七项场景覆盖立即退出、二进制/非零、信号映射、大输出、文件/网络拒绝、owner 存活及 SIGKILL 后按原 ref 停止 setsid 后代。每项重复停止及同键拒绝成立；七 scope、native 临时目录与本次进程全部清理。实际命令、结果、源码对照与清理由[Linux 导航](../evidence/23-linux/README.md)持有。这不是 Linux 全产品构建或 durable 业务链验证。
- 独立实现审查 `worker_review` 直接读取规格、前片、源码、调用方及文档，在隔离副本亲跑 36/36，最终内部函数提取后再跑受影响 5/5；Coding 原/新构建产物逐字节相同，个人产物只有四个 Node 内置外部导入。空白命令、cwd 核对、显式依赖误享 code-root 例外三项隔离负例均红，未改共享源码。见[审查记录](../evidence/23-macos/implementation-review.md)。
- 审查发现并修复目录替换阻断：Node 的 cwd 字符串可缓存，单看 `.` 身份与规范路径仍会在已移走的旧目录执行。现在同时 stat payload 路径与 `.`，两者必须匹配原 dev/ino；回归先让 worker 收到 1 MiB 输入并等待初始化，再替换目录。原反例修复前返回 0 且写出标记，修复后返回 125 且两处零执行；只撤去路径 stat 后加强用例必红。[前](../evidence/23-macos/review-cwd-before.log)、[后](../evidence/23-macos/review-cwd-after.log)、[撤修复](../evidence/23-macos/review-cwd-mutation.log)均保留。
- 原失败：初次 esbuild 多入口生成了嵌套目录，发现后设置固定 entry-names，最终旧路径及字节保持；两轮静态因 README 字符预算超 10/1 字符失败，仅缩短同一构建注释后通过，原日志保留。Linux 首轮探针将 npm 自身误当 Pi 依赖，在 prepare 后、launch 前失败且零命令，修正断言后通过；中间七项与最终七项不累加。
- 最终材料独立复核：`worker_review` 核对本机最终构建/静态通过，Linux 59 项材料哈希/字节、快照与当前工作区一致，七项 summary/stop/cleanup 的 scope/ref/observation 逐项对应，二进制和大输出哈希独立核算一致，真实探针取消时序及占用清理证据无阻断。没有将离线桩、生产 snapshot 或输出哈希冒充真实模型/IM或命令效果回执。
- 工程验收：通过。拥有者已授权本次提交，未授权推送或部署；总迁移仍在实施。
- 产品验收：不适用，本片没有新增用户入口。真实模型/IM、durable 命令业务链及完整矩阵继续由总工单持有。

## Comments

2026-10-17：拥有者指示接手总工单，核对最新内容后补齐独立命令执行前提；正式入口与部署保持原装配。

2026-10-17：独立方案/实现审查后修复 cwd 缓存导致的目录替换漏检，最终离线、构建、静态与 Linux 七项真实执行通过；当前未提交、推送或部署，最终工程证据待独立复核。

2026-10-17：最终材料独立复核无阻断，本片工程验收通过，源码/归档/两平台产物相符；交回总工单继续 durable 命令消费者，未提交、推送或部署。

2026-10-17：拥有者指示提交本片；提交前核对 12 个实施/说明文件、两类 worker 产物与已验归档一致，沿用相同快照的工程及独立审查结论。更新工单提交交接记账，并按提交门禁规范四份本机证据日志的末尾空行或行尾空白，测试结果不变；未推送或部署。
