# Agent Note: 完全访问命令沿持久 scope 与原工作恢复

Status: implemented

## 问题

[durable 命令](2026-10-17-personal-durable-commands.md)仅接通受限模式，完全访问仍被拒绝。共享 local launcher 的进程组只在内存中，不足以在后台强杀后核实原执行停止；复用受限 prepare 又会改变已确认的账户环境、目录外访问与网络语义。

## 决定

Linux 完全访问命令直接在持久 tracking 的 user scope 内启动同一自包含 worker，不经过 bwrap、网络过滤或受限运行依赖。非 tracking 的原生入口仍拒绝完全访问；Coding 的默认 launcher 与受限准备不变。复用[原生持久身份](2026-10-17-native-linux-execution-identity.md)的独占认领、启动前停止标记、token、InvocationID、launcher、cgroup dev/ino 与 FD 停止；没有原 launch 认领或请求/launch 指纹不符时，不以 stop 先手证明旧执行退出。

个人 prepare 保存原 cwd、worker、Node、临时目录，mounts/runtimeReadRoots/toolAliases 为空，env 为空对象；实际 spawn 时才调用共享 workerEnv 继承后台用户环境并去除内部控制变量，环境值不作为准备输入或请求指纹保存。固定初始 cwd 与 dev/ino 不构成完全访问的路径限制；命令可访问目录外、网络及同账户后台数据与凭据，免逐次审批，沿[当前账户完全访问](../feature/2026-10-12-full-access-current-account.md)的已确认信任范围。

子会话每次请求由 command-permission section 展示原工作模式，来自已持久化的工作索引与权限，section 和实际模型请求均留证据，长期上下文不作为当前权限依据。

宿主回执、原始双流、严格停止、原工作 owned Task、全部收尾、来源暂停与报告恢复共用既有命令实现。恢复按原权限分别核实准备形态；完全访问的空数组/空环境和固定 Node/worker 必须匹配，不能借此跳过证据核验。未知或停止未核实仍暂停原工作，模型不能切模式、换成员或服务绕过；人工效果与 OS 停止分别核实，恢复不再获取执行权。

记录字段、Task/document 版本及既有 mode 枚举保持。旧程序在 resume 前扫描所有命令，遇原工作 full_access 明确拒绝（包含终态），不会将新执行套回受限恢复；无需为相同数据形态增加档案版本。隔离旧程序拒绝证据、实际 OS 与离线回归由[工单](../../../../.scratch/personal-pi-durable/issues/26-full-access-commands.md)持有。

## 既有笔记审计

[个人会话后台](../feature/2026-10-21-personal-background-processes.md)复用本篇完全访问原scope执行与停止能力，新增独立会话归属和共享目录认领；本篇仍持有原工作命令的执行事实。

按完全访问、个人命令、持久停止与环境检索 active notes。当前账户完全访问、原生持久身份、[命令宿主](2026-10-17-personal-command-execution.md)、[固定命令目录](2026-10-17-personal-command-configuration.md)、durable 命令与迁移总提案部分重叠，保留各自归属并互链。本篇只取代这些前提中完全访问尚未接通的限制，不改变受限边界、旧 local 停止承诺或 MCP 待接入状态；没有完全吸收或失效提案。

## 备选方案

- 直接使用 local launcher：无需增加平台分流，但内存 PGID 无法跨强杀证明原执行退出，而且会带入旧 worker/SDK。
- 把完全访问映射到受限 prepare：能直接复用运行依赖与保护根核验，但会清除用户环境并限制目录外和网络，违反已确认模式语义。
- 将全部用户环境持久化后执行：可以重建环境，但会把凭据值复制到操作记录，扩大秘密持有范围；恢复只核实旧执行，从不重启，不需要重建该环境。

## 后果

MCP 的独立 HTTP 入口见[传输复用](2026-10-17-mcp-transport-reuse.md)；本篇的本机 scope 退出证明不能用于 HTTP 远端操作。

三模式共用操作事实与恢复路径，无新依赖、配置项或平行状态机。完全访问仍需 Linux user systemd/cgroup v2 及原组停止能力，但不依赖 bwrap/AppArmor 策略；原目录、机器、TMPDIR 和证据须保留。执行意图提交后、外部认领保存前的崩溃窗口继续保守未知和占用。

完全访问同账户能修改后台档案和证据，私有权限不是其安全隔离；持久停止证明仅覆盖原执行单元及仍在其中的后代，不承诺收回主动迁出、另行提权或外部服务。命令自己的输出可能包含它主动读取的环境值，宿主保存完整双流，不将此误称为输出脱敏。正式入口、部署、真实模型/IM、产品体验及完整迁移仍按总工单分别验收。
