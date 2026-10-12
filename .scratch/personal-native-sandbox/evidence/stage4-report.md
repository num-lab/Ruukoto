# 最终交付与验证

基点为 `c4ed540280233ee38e49dfe16bcea825004349c5`，按工单的四阶段出口顺序实施。第一阶段通过后切个人入口，第二阶段通过后删除 Docker worker。没有操作 tx 在线个人实例、生产档案或其他容器；没有卸载 Docker、改变既有 docker 组成员、关闭整机 userns 加固或放宽 worker 超时。

## 交付

两个产品正式 CLI/server 默认且只接受 native，开发入口清理继承覆盖并沿产品能力声明启动。旧 local/container 参数与环境覆盖明确拒绝，完全访问仍使用启动账户。Docker launcher、后端值、专用配置、managed container 类别、UID/GID 权限预检、Docker Desktop inode 例外、镜像和构建入口删除；工作副本权限统一用实际账户 accessSync，保留补充组/ACL。

真实定时材料分析暴露只读工具范围未钉定的问题，在 ToolRouter 下发空 readRoots 修复；confirm/full_access 的只读材料与同级文件拒绝用例先失败后通过。原生 ready/init 的原始错误通过标准 Error.cause 保留，外部 code/reason、受管身份与停止结论保持原契约。停止未核实仍保留占用和现场，效果未知操作不重放。

systemd 模板保留实际账户的系统服务，依赖 user@UID.service，使用实际 Node 绝对路径，明确 runtime dir/user bus；部署说明交付 linger、宿主工具、原生前置、升级与回退。README、usage、development、受影响模块、验证入口与提交检查 skill 同步。主笔记转 implemented，八篇被部分取代的笔记更新互链和适用范围，原决定与历史验证保留。

## 验证

| 覆盖 | 命令与结果 | 原始证据 |
| --- | --- | --- |
| Linux 常驻前提与真实停止 | 独立账户系统服务、无登录定时、登录退出、SIGKILL 恢复、真实 setsid 后代、可销毁 Ubuntu VM 冷启动与 guest reboot；54 项原生边界探针通过 | [第一阶段报告](stage1-server-report.md) |
| 个人产品真实执行链 | 04 6/6、13 6/6、15 8/8、18 7/7、28 全部通过；UID 996 无 Docker socket 权限，模型/IM/通知为桩 | [第二阶段报告](stage2-report.md) |
| macOS 正式与开发入口 | 29/32/71/72/73/15，83/83 | [入口日志](stage2-macos-entry-tests.log) |
| 审批、模式、委派、调度与消息 | 08/58/63/64/80/51/86 messaging/84 delivery，88/88 | [契约日志](stage2-macos-contract-tests.log) |
| 材料分析缺口的先失败后通过 | test80 两个新用例；修复前 2 failed，修复后 2 passed | [失败](material-scope-red.log)、[通过](material-scope-green.log) |
| macOS 原生 Coding Agent | smoke26 worker 10 项、worktrees 8 项通过；清理已核实 | [worker](stage2-macos-worker.log)、[worktrees](stage2-macos-worktrees.log) |
| Docker 删除后的生产调用者 | 07/10/22/83/95/100/101/scope，102/102；84 integrate 共用夹具回归 13/13 | [生产报告](stage3-production-report.md) |
| Docker 删除后的 Linux Coding Agent | smoke26 worker 10 项、worktrees 8 项通过；正式按需入口与真实停止 | [第三阶段报告](stage3-report.md) |
| 最终开发入口、恢复与联合发布 | `npx tsx --test test/32-dev.test.ts test/71-product-entry.test.ts test/86-subagent-recovery.test.ts test/91-release-acceptance.test.ts`，48/48 | [日志](stage4-entry-recovery-release.log) |
| 最终 Linux 停止与缺能力拒绝 | native 4 项、scope 3 项、worker-stop 31 项；模板渲染并 systemd-analyze verify 通过 | [Linux 报告](stage4-linux-report.md) |
| foundation 与活跃验证命令 | foundation 9 passed / 1 个真实模型按要求 skipped；99 6/6；Python 原生探针自检通过 | [第三阶段报告](stage3-report.md) |
| 构建 | `npm run build`，退出 0 | [日志](stage4-build.log) |
| 最终静态检查 | `npm run check:static`，退出 0；lint、所有 workspace typecheck、47 篇 notes 和文档门禁通过；锚点报告没有悬空引用 | [日志](stage4-static-final.log)、[锚点](stage4-note-anchors.log) |

## 双产品升级保全

`npm run test:upgrade` 在 macOS arm64 / Node 24.15 上使用协议 19 的 `8bccb8f`，两份独立旧安装各自 npm ci/build，再逐端更新源码、npm ci/build。旧个人入口使用该版本允许的 local，旧 Coding Agent 使用该版本允许的 native；新版两端均不传执行覆盖，以默认 native 实际完成 bash 写入。另一端保持原 PID 与实例身份并继续完成任务，八种旧参数/环境覆盖在启动前拒绝。

旧版实际执行单次批准的越界文件读取和修改委派；升级后核对审批全行、产物文件字节、JSONL 原历史前缀、work_delegations 与工作副本成果保全。裸 SQLite 播种已知的停止未核实形态，升级后核对 task interrupted/effect_unknown、SubAgent unverified、paused/occupancy_unverified 与精确占用；对应真实子上下文的模型请求数不增长，不把播种形态当作真实 OS 强杀。

首跑默认 `5e84daa` 因协议不兼容退出 2，见[原始记录](stage4-macos-upgrade.log)。增强夹具的失败运行发现需要显式 request_file_access、准确区分父子模型上下文，以及旧 native 安装也要构建，修正后完整保全 4/4 通过，见[构建旧版本后的记录](stage4-macos-upgrade-built.log)。加入不重放计数后 4/4 通过，见[记录](stage4-macos-upgrade-no-replay.log)。最后一次把计数限定到对应工作真实子上下文并断言基线非零，4/4 通过，结果保存在[最终升级记录](stage4-macos-upgrade-final-verified.log)。失败日志保留，不重新归为通过。

所有升级后台均核实退出；两个明确播种的异常占用与对应临时档案按设计保留，不自动 resume-queue 或删除现场。保留路径与任务 ID 由各次日志末尾报告。

## 范围与资源

Linux 实测为 Ubuntu 24.04 x64；manager 可用但 scope 没有 ControlGroup 或 cgroup.kill 不可写的精确分支使用定向替身，真实 Delegate=no 负例导致 manager 的 init.scope PermissionDenied 后拒绝。不能把这些记录扩大为全部 Linux、cgroup v1 或真实外部平台验收。

没有运行全量 npm run check、真实模型或真实 QQ/Telegram 外发；使用对应改动面的定向用例与真实 OS 验证。原生临时 HOME/TMPDIR 使用宿主磁盘，没有单任务配额；未知停止现场会继续占用磁盘。macOS 原生监督器的已接受限制继续由原生执行笔记持有。本次交付不包含生产切换，升级旧 worker 仍须按实例核实，不能用全局清理或删除占用记录替代。

服务器验证结束后，165 个本次只读依赖挂载与新账户/linger/user manager 已清理，UID 996 无进程，生产服务保持 PID 3963064 / active，见 [清理原始记录](stage4-cleanup.log.gz)。VM 已关闭并释放镜像，安装的 QEMU 工具包留存；已识别的未知占用、两个 smoke18 崩溃场景与原始证据保留。清理记录中段工具输出曾截断，最终断言和退出 0 完整保留，范围见 [Linux 报告](stage4-linux-report.md)。八篇旧笔记的决定和验证段逐段比对不变，见 [记录](stage4-historical-note-sections.log)。

工单标为 resolved 后，最终文档门禁再次退出 0，见 [日志](stage4-docs-final.log)；git diff --check 通过，工单、规格与报告的本地链接逐项存在。最终改动范围见 [change-scope](stage4-change-scope.json)。

提交前暂存检查发现原始日志的 CR/终端空白及四份原始记录的文件末尾形态与源码约定不同。日志使用本目录的局部 Git 属性保留原始字节；四份不满足末尾换行门禁的记录以 gzip 无损存档，解压内容逐字节核对相等，不格式化或重写原始证据。
