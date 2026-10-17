# Agent Note: 固定服务检查以受保护认领核实原执行退出

Status: implemented

任意命令的停止证明另见[Linux 原生执行持久认领](2026-10-17-native-linux-execution-identity.md)，不沿用本篇固定检查的同组后代假设。

## 问题

[个人迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)要求子工作停止核实后才释放占用。[活调用退出](2026-10-17-service-helper-exit.md)等待 close，但后台 SIGKILL 后 detached helper 可能遗留。无身份 inspect 的新观察不能证明原执行停止；[原生 launcher](2026-10-10-native-execution-sandbox.md)则持有固定 worker 装配与内存闭包，不能直接作为 durable 持久句柄。

## 决定

固定 helper 增加独立检查身份与机器参数。启动前在 root 保护目录认领，记录 bootId、PID、starttime 和进程组；同 ID 永不再次执行。停止核实先形成不可撤销的停止标记，只在停止先手、跨 boot，或原启动器和整个原组均已消失时返回真。未知认领和观察错误保守返回未核实，不从持久 PID/PGID 发送杀进程信号。

调用侧为检查建立独立组，但不要求提权后的 helper 为组首领：sudo 可保留同组监护。整个组不存在仍足以证明原成员全部退出；多余组成员只延后核实，不会产生假停止。实际 Linux sudo 身份探针暴露了首领限制的可用性问题，非首领执行与存活同组监护纳入回归。

该证明仅覆盖 helper 内固定降权、同组的 systemctl show，不向 systemd 创建命令单元或派发写入，也不用于任意命令、MCP 和主动脱组后代。原三个动词及 restart 的跨连接核实保持。检查与 restart 使用不同 ID 前缀和认领类型，不能交叉解释。

本片只交付 helper 原语。实际 durable 消费者须在 spawn 前提交机器、原检查身份及工作归属，恢复先核实旧执行再决定新观察；未核实保持原占用，不用新 ID 绕开。旧 helper 不支持协议时拒绝开放。完整归属、逐次权限与子工具继续由总迁移实施。

## 既有笔记审计

按 helper、inspect、服务检查、后台工作、停止核实与 native 检索 proposed/implemented/rejected。[服务检查](../../implemented/architecture/2026-10-17-personal-service-inspect.md)、[服务操作](../../implemented/architecture/2026-10-17-personal-service-operations.md)、[固定 helper](../../implemented/architecture/2026-10-03-service-management-helper.md)、活调用退出和迁移提案部分重叠，保留各自协议和运行归属；本片不取代原 inspect 或 restart。native 的 worker/cgroup 契约与本片不同，不迁入。没有完全吸收或过时提案。

## 备选方案

- 直接在恢复后再 inspect：只读可重复，代码最少，但无法证明原执行已停，不能释放子身份。
- 为每次检查创建 systemd 命令单元：cgroup 能约束任意后代，但固定 show 不需要任意执行；新建单元引入跨连接创建请求、回执与迟到停止，增加当前不需要的状态。
- 按持久 PID/PGID 发停止信号：能主动回收孤儿，但读取 starttime 与发信号之间存在复用窗口。只观察可保守阻塞，不承担杀错进程风险。
- 一并开放子工具：能直接获得模型消费者，但还需 durable 尝试身份、来源权限与整项取消。先独立验证 helper 原语，不能据此提前记完整生命周期通过。

## 验证

见[实施工单](../../../../.scratch/personal-pi-durable/issues/16-inspection-identity.md)。真实 Linux 进程覆盖后台强杀、原 helper 与同组后代分别存活、认领到启动窗口、同键拒绝与停止先手；身份、机器、坏记录或观察错误不得假报停止。旧协议回归保持，独立审查反证关键核实。

## 后果

顽固进程、进程组号复用或损坏认领可长期保持未核实，需要运维查明；本片不增加强制释放入口。该检查原语没有约束主动脱组的通用进程，不能用于后续 bash/MCP 的停止证明。原有未携带身份的 inspect 不因新增动词获得恢复保证；新 helper 尚未正式部署；[durable 消费者](2026-10-17-personal-durable-inspection.md)另持有检查尝试、来源及恢复证据，不扩大本协议的 OS 证明范围。
