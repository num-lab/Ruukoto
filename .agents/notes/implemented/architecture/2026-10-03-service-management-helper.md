# Agent Note: 服务管理经过 root 拥有的固定 helper

Status: implemented

原编号：ADR 0019

## 问题

main 需要按明确授权管理服务器，但它没有 bash，受限编码容器不能管理宿主 systemd；systemd 工作进程启动器仅接受完全访问，其执行 UID 也无服务管理权限。直接开放命令或扩大执行账户 sudo 权限无法维持[访问模式](../feature/2026-09-19-explicit-access-modes.md)与[执行边界](2026-09-20-tool-worker-per-task-container.md)的账户隔离。[两个产品](2026-10-02-two-agent-products.md)要求个人服务器独立执行，并允许拥有者经原 IM 入口审批。

## 决定

服务管理只经过 root 拥有的固定 helper `deploy/systemd/ruukoto-service.mjs`，安装权限 0700，仅后台账户经 sudoers 固定路径调用。helper、策略、操作标记及父目录属主与写权限受验证；模型或保留环境变量不能决定可执行文件、配置路径、执行身份和 systemd 参数。

helper 接受固定 `inspect / restart / stop-op` 协议。root 拥有的策略文件固定本机身份、执行 UID/GID、精确规范的 `.service` 单元与允许动作；拒绝别名、模板实例、通配符、路径、选项注入和额外参数，固定禁止后台、Docker、执行工作进程、helper 自身操作单元及 dbus 等基础设施目标。检查降至策略执行账户，只返回固定状态字段，不暴露整个 unit、环境或任意日志。重启由 `systemd-run --pipe --wait` 创建短命命令单元，以 root 执行固定 `systemctl --system restart`，结构化 argv 与绝对路径，不提供 shell 或自由命令参数。restart 在目标不活动时会启动它，可信 unit 的依赖传播照常发生，审批必须说明这些影响。

宿主操作 ID 派生命令单元（`ruukoto-service-op-<hostOpId>.service`），设置有界运行时间与 `KillMode=control-group`。固定 root 操作目录中用原子 mkdir 持久认领一次执行权，同一 ID 已有标记则拒绝；标记失败后也不自动解除，不随 transient unit 回收而删除，仅证明已认领，不证明服务已重启。stop-op 只停止同一 ID 的命令单元，不能接受任意目标。受管进程登记覆盖 starting 与迟到创建，只有核实启动器及其进程组、命令单元/cgroup 均已退出才释放占用，查询失败不等于退出。

`claim.json` v2 保存 helper 的 PID、Linux starttime、进程组与 boot ID。stop-op 先写停止标记、观察并停止命令单元，再以原进程身份及 `kill(-pgid, 0)` 核实启动器已退出、进程组消失，最后检查命令单元；应答保留 `v:1`，以 `launcherExited` 区分启动器证明。只看命令单元 not-found 会漏掉已经检查过停止标记却尚未派发的 helper；只看 helper PID 又会漏掉父进程死后仍可能派发的 systemd-run 后代。PID/starttime 防 PID 复用，boot ID 区分重启；无法读取、缺失、损坏或旧版认领均不提供停止证明。stop-op 自己原子新建的认领证明从未派发，跨 boot 可排除旧进程及旧请求。重复增加停止标记检查仍有检查与派发之间的竞态，因此采用进程组消失证明；该检查可能因无关组成员或僵尸进程保守保留占用。

进程组消失仍不能排除已送入 D-Bus、尚未被 PID 1 处理的创建请求，跨连接 stop/show 不提供这项顺序保证。因此 helper 仅在 `systemd-run --pipe --wait` 退出 0 后、应答前持久写 `launcher-completed.json`，非零或异常不推断结算；stop-op 只在成功查询实际看到 `LoadState=loaded` 时持久写 `unit-observed.json`。两种证明均绑定原操作、命令单元和启动器完整身份；组已消失且单元 not-found 时，还须其中一种证明才能报告 `exited:true`，先手停止认领和跨 boot 例外。缺失、半写、损坏或身份不符继续保留占用；即使命令实际结束但回执丢失且单元已回收，也不会猜测安全退出。`launcherExited:true` 单独不足以解除占用，服务重启效果仍须另外核实。

`service_inspect` 是无写入效果的状态查询；`service_manage` 首版仅 restart，仅 Personal Agent/Linux/显式部署配置的可信 main 任务装配和调用。模型只提供精确白名单单元与固定动作，本机、身份、任务与操作 ID 由宿主确定。main 不因此获得 bash，执行账户不获得新增 sudo/Polkit 或策略外部署材料访问。

没有有效[长期授权](../feature/2026-10-03-standing-permissions.md)时，任何访问模式的 service_manage 都逐次人工审批，包括 full_access，auto-review 对服务范围也转人工。full_access 仅代表执行账户已有权限，helper 的 root 分支是后台获得的新提权能力。issue 10 增加的限定授权例外独立记录于上述笔记，不能扩展到应用数据破坏性变更、通知外发、MCP 写操作等其他特殊审批。

审批固定本机、规范单元、restart 与修订指纹：策略内容、unit/drop-in 定义内容及已加载配置。活动状态/PID/InvocationID 是观察值，不进入修订，避免正常状态变化使审批失效；未加载新定义或不可信配置拒绝。说明保存必要身份与摘要，不泄露配置正文。批准消费前复核 main/任务/权限版本、原 IM 固定身份和部署修订，helper 在请求 systemd 前再次复核；修订或固定身份改变则失效。通知、列表、详情、决定回执、单次批准消费和原目标回复均复用[IM 审批路径](../feature/2026-10-02-im-approval-and-final-report.md)，不另建服务控制账本或页面。

## 结果与中断边界

批准消费与 systemd 无跨系统事务。未消费或可信请求前拒绝是已知未执行，状态查询中断无写入效果；已消费且无可信结果一律效果未知，同操作 ID 或新 ID 都不自动重发，由拥有者核实后重新申请。非零命令退出可能包含服务停止但启动失败，不能统一说成零效果。取消只回收命令单元，PID 1 已收到的作业可能继续，不自动停止目标作为回滚；服务操作未知与 outbox 发送未知分开记录。

stdout/stderr 原始字节先进入 ArtifactStore，再给模型有界视图；正常回收记 complete，中断/捕获失败保持 partial，产物引用进入 `task.tool_result`。证据包括操作 ID、单元、实际执行身份、退出码、观察时间与前后状态。命令退出 0、服务 active、业务健康分别表述；后状态查询失败保留已知命令结果并说明无法核实。缺 Linux/systemd/helper/sudo 权限明确失败，不降级到后台自由执行，不向容器开放 systemd bus、Docker socket 或控制面。

## 验证

[工单 09](../../../../.scratch/agent-direction/issues/09-linux-service-management.md)记录：macOS 模拟双 IM 平台与 helper 替身下 test/78 22/22，覆盖身份/产品/平台门、所有模式审批、篡改拒绝、修订失效、同 ID 单次认领、取消窗口、重启未知与产物引用。规定联检批次、`npm run typecheck`、test/67 3/3 通过；当时全量 `npm test` 838 项中 837 通过、1 个真实模型门控跳过。

[smoke-09](../../../../.scratch/agent-direction/smoke-09-linux-service-management.mts) 在 `ssh tx` 使用真实 helper/sudoers/systemd/测试服务/隔离后台，模型与 IM 平台为桩，三轮各 14/14。InvocationID 改变且 starts 恰 +1、执行账户越界全拒、同 ID 拒绝重复、策略与未加载单元修订失效、派发后 kill -9 恢复效果未知且不重发均有证据。测试服务卸载，日常后台未受影响；真实 QQ/Telegram 平台尚未实测。

sudo 默认关闭 fd3 导致原协议通道失效，真实冒烟暴露后改为 stderr 前缀单行 JSON；派发后异常不能再假报未执行，实际身份与 IM 结构化范围说明也已补齐。策略路径由宿主配置与 helper 固定路径双向核实，不一致明确失败，部署要求见[systemd 说明](../../../../deploy/systemd/README.md)。

## 备选方案

向 main 开放 bash 可以直接调用已有系统命令，但 main 的工具权限与宿主管理能力会混在一起，且受限容器本来不能管理宿主 systemd；[工单 09](../../../../.scratch/agent-direction/issues/09-linux-service-management.md)因此选择结构化固定工具与 helper。

给执行账户 sudo/Polkit，或复用现有 full_access 工作进程启动器，可以复用原命令执行路径；原账户隔离明确要求执行账户不能取得后台提权能力，现有启动器又不支持请求确认任务，故不把 confirm 改成 full_access，也不扩大执行账户权限。

## 后果

服务器管理有真实、可核查的 root 能力，同时保留明确目标、修订绑定、单次认领与效果未知不重放。代价是部署必须维护 root-owned helper/策略/sudoers 和可信 unit，SQLite 与 systemd 不能整体原子，取消不保证撤回已提交作业。日志、其他动作和远程主机当前不支持；有实际需求时按固定协议扩展，不引入通用执行框架。[部署与服务管理](../../../../docs/modules/deploy.md)记录当前操作范围。

[个人 durable 服务检查](2026-10-17-personal-service-inspect.md)复用 app 内共享传输，只提供 inspect 及证据读取；本篇写入授权与效果未知约束继续适用，不能从只读检查推得 restart 已接入。

[个人 durable 服务操作](2026-10-17-personal-service-operations.md)通过另行启用的可信宿主 API 接入 restart，使用独立的 durable 后台工作与单次审批；模型尚无服务写工具，原 IM 和长期授权尚未接入。该实现要求 `launcherExited:true` 与 `exited:true` 同时成立，不能把旧部署版本的应答当作停止证明。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
