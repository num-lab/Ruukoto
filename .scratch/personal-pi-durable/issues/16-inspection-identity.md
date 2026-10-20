# 服务检查的持久执行身份与停止核实协议

Status: resolved

## 目标与边界

接续[总工单](01-migration-plan.md)与[helper 中断处理](15-helper-exit.md)，补齐后台 SIGKILL 后固定只读 helper 的核实原语。当前 `inspect` 没有稳定身份；后台消失后无法区分旧检查、遗留进程和新的观察。本片提供固定服务检查的受保护认领及停止证明，不下放子工具、不将新协议接到现有 durable 重放、不改变正式入口或部署。

## 方案

- 新增固定动词 `inspect-op <inspectionId> <machineId> <unit>` 与 `stop-inspect <inspectionId> <machineId>`；检查 ID 为 `inspect_` 加 24 位小写十六进制，与 restart 的 `op_` 隔离。两者先核实部署与期望机器，其他机器不得认领或证明停止。原有三个动词及应答保持。
- inspect-op 在任何外部子进程启动前原子 mkdir 认领，再保存受保护的 bootId、PID、starttime 与进程组；已有认领永远拒绝重复启动。调用侧创建独立组，允许 sudo 监护与 helper 同组；helper 不必为组首领，额外成员只会保守延后停止核实。检查仍是固定降权 `systemctl show`，不派发写请求或 systemd 命令单元。
- stop-inspect 先认领不存在的 ID 或写持久停止标记，阻止迟到启动；只有停止先手的完整认领、跨 boot，或可信原 helper 身份已结束且原组不存在，才报告 `exited:true`。缺/半写/非法认领、同组后代仍活、权限或 /proc 错误一律 false。不对持久 PID/PGID 发杀进程信号，组号复用只会保守阻塞。该证明不能用于任意命令、MCP 或主动脱组后代。
- 应答固定原检查 ID 与本机，inspect-op 同时带原单元；调用方必须核对全部身份。未来 durable 接入必须在启动前提交机器、检查 ID 与 Task/工作归属，恢复先核实旧 ID 才可建立新的只读观察；不能每次 replay 直接换 ID。旧 helper 不识别新协议时拒绝开放，不回退旧 inspect。
- 实际改动面为部署 helper、新协议应答类型、Linux 真实进程窄测试及 deploy/agent-tools/个人模块说明；旧个人与 durable 调用方仍使用原协议，跑传输、旧 78/79 与个人服务回归。不增加依赖、配置、入口或通用执行框架。

## 验收与证据

- 必须复现后台进程 SIGKILL 后 detached helper 仍活，stop-inspect 保持 false，原 helper 与同组后代结束后才能 true；迟到同键启动与已执行同键启动都拒绝。
- 覆盖原 helper 已死但后代仍活、检查已认领尚未 spawn、claim 缺失/半写/非法/类型不符、机器不符、原身份失配及非首领检查/仍活的同组监护；停止标记和可信停止证明跨进程恢复。
- macOS 执行静态与受影响调用方回归；Linux 独立副本执行同一调用方集合及新真实进程测试，区分系统命令桩与真实 systemd。独立方案审查后实施，独立实现审查至少做撤去关键核实的负例。
- 本片无新增产品交互，产品验收不适用；子工具、durable 生命周期、真实 systemd/模型/IM 与完整 A1–A12 不计通过。

## 进展与交接

- 当前角色：工程交接。接手 HEAD `3f38ad9`，分支 `Eitrous/migrate-to-pi-durable`，工作区初始干净。总方案确认与实施授权继续有效，本片属于其停止核实要求；本次提交承载实现、测试、说明与证据，范围以相对基点 diff 与[内容快照](../evidence/16-inspection-identity.sha256)核对，快照排除工单及证据。
- 只读调查 `execution_design` 核实 native launcher 依赖内存闭包和固定 worker 装配，不直接复用；固定 inspect 的直子进程不使用 detached，故只观察原组可提供本范围的保守停止证明。新建 systemd 命令单元会引入不必要的跨连接创建核实，采用本协议。
- 独立方案审查 `execution_design` 直接核对本片、提案、总规格及 helper/launcher 源码，无未解决阻断；亲跑 notes/docs 和新文件空白检查通过。实现必须在跨 boot 快路径前验证完整身份，且保持原 restart 的跨连接证明。
- 实际 Linux sudo 身份探针发现 helper 非首领，原方案的首领限制使生产安全拒绝但不可用；独立技术复审确认只观察原组不要求 helper 为首领。已移除该限制并以非首领正常执行、同组监护仍活时未核实回归替换，原组正整数与完整身份校验保持。
- 决定与备选见[执行身份](../../../.agents/notes/implemented/architecture/2026-10-17-service-inspection-identity.md)。实现、文档、macOS/Linux 验证及独立实现审查完成；仍不声称子工作外部执行已完成。
- 下一角色：总工单实施者。在 durable 中先提交原检查身份、机器与 Task/工作归属，恢复时核实原 ID 后才能新建观察；处理版本门禁、取消、意外终态及停止未核实占用，再接子工具权限。不能直接把现有 replay-safe inspect 换成每次随机 ID。

## 验收结果

- 工程验收：通过。新协议先核机器、认领后同 ID 不再启动；后台强杀、原 helper 退出而同组后代仍活、认领到 spawn 的两段窗口均保守保持未核实。损坏/错绑/旧记录与 proc/进程组观察错误不形成停止证明；sudo 非首领可执行，同组监护仍活时不释放。旧 restart 的创建请求与操作单元证明保持。
- macOS 27.0.1 / Darwin 27.0.0 / Node 24.15.0 / npm 11.12.1：setup、build 与最终 check:static 通过；六文件相关调用方 136/136，零失败/跳过。首次静态发现测试向 spawnSync 传 undocumented detached 选项的类型错误，已改为受支持的 spawn bootstrap 后通过；最终原始日志、命令与环境见[本机证据](../evidence/16-macos/summary.json)。Linux 专属场景不在 macOS 记通过。
- Linux 6.8.0-117 / Node 24.21.0 / npm 11.19.0：专属 tmpfs 当前源码副本独立 setup/build 通过，七文件串行 149/149，零失败/跳过；包含同一最终 helper/test 哈希上的 13 个进程检查（11 顶层、2 子用例）。安装后仅清理本次 npm tar 缓存以控制 tmpfs 用量，依赖未动，套件无 ENOSPC 失败。环境、原始日志、最终哈希及清理见[Linux 证据](../evidence/16-linux/summary.json)。版本不等于 CI 精确矩阵。
- 独立实现审查 `execution_design` 直接读取规格、方案、实际源码、调用方及说明，无未解决阻断。本机相关五文件 119/119；最终 Linux root 与普通用户各 13/13，是同一集合，不累加唯一场景。root 使用 `/opt` 专属夹具，保留部署路径属主校验及检查降权；systemctl/systemd-run 仍为命令桩。撤去组观察与停止标记的两份 root 隔离反证各 1 项预期失败，捕获误报停止与迟到启动。完整最终 Linux 原始日志、实际源码、反证副本、命令及清理见[独立审查](../evidence/16-linux/independent-review/README.md)；本机独立审查工具响应未另存完整日志，材料已明确区分。
- 两端 Coding 打包 SHA-1 均保持 `5af04e561c9fbf84bf29f8237e3655e563ea5ed9`；本轮无依赖、命令入口、安装步骤或正式工具装配变化。README、开发说明与 pre-push 的既有命令核对后无需调整；helper 新协议和 sudo 组语义同步在部署说明与模块文档。
- 产品验收：不适用，本片没有新增人机交互或主观产品取舍。未跑全仓 check、正式 helper/sudoers、真实 systemd 服务操作、模型/IM；未接 durable 消费者或下放子工具，不计完整 A3/A5/A9。顽固组、组号复用或坏认领仍可长期保守阻塞。

## Comments

2026-10-17：接手总工单。先为固定 inspect 补最窄的持久核实协议，避免把只读重跑、活调用 close 或 PID 消失当作后台崩溃后全部停止。

2026-10-17：独立方案与实现审查无未解决阻断；实际 sudo 探针暴露的首领限制经技术复审移除，停止证明保持原组整体退出。macOS 136/136、Linux 149/149 与独立 root/非 root 13/13 通过；本片 resolved，总迁移继续 in-progress。未提交、推送或部署。

2026-10-17：拥有者指示提交本片；源码、说明与已验内容快照一致，工程证据及独立审查结论沿用。durable 消费者、完整迁移与真实环境验收继续后续，未推送或部署。
