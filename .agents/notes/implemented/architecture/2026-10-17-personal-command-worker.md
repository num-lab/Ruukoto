# Agent Note: 个人命令使用自包含的单次 worker

Status: implemented

## 问题

[Linux 持久执行身份](2026-10-17-native-linux-execution-identity.md)接收已准备输入；共享 worker 的准备需要旧 Pi SDK 并开放整个 node_modules。直接复用它会把旧 SDK 与编码工具循环带回[个人 durable 迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)，也不能以旧 Host 的内存取消代替跨进程停止证明。

## 决定

原生准备允许宿主显式声明运行依赖，空列表用于自包含 bundle；省略时保留原 Coding 行为。显式依赖沿用真实路径、保护根及最小可见范围校验。

个人命令 worker 只依赖 Node 内置模块，stdin EOF 前收齐单次有界 UTF-8 JSON，拒绝空白/NUL 命令及无效目录身份；复核 payload 真实路径和当前 cwd 的 dev/ino 后启动固定 Bash，继承已有 cwd，不按路径重新打开。宿主先等待原生 launch 返回并接好输出/退出消费，再提交 stdin，避免快速命令在 scope 身份观察前退出。输出直接传递原字节，不加入旧工具协议、模型视图或操作恢复状态。它不解释命令的读写性质，不授予权限，不证明外部效果；命令退出后仍由宿主按持久引用核实 scope，不能按主 PID、退出码或 stderr 认定工作可复用。

[单次命令宿主适配](2026-10-17-personal-command-execution.md)消费该产物并保存输出及运行返回证据，不接个人工具清单。durable 调用方须在发送命令前持久化操作及原执行引用，逐次复核原工作权限；取消、恢复与临时资料清理均受原停止证明约束。

## 既有笔记审计

按 worker、运行依赖、native、个人 durable 检索活跃笔记。[共享 worker](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md)与[原生沙箱](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)部分重叠，保留 Coding 路径和平台隔离规则；[Linux 持久执行身份](../../implemented/architecture/2026-10-17-native-linux-execution-identity.md)保留停止权威，本片补输入准备。没有完全吸收或失效提案。

## 备选方案

- 复用旧 Pi worker：已有数据流与工具结果，但引入旧 SDK、四工具循环及与新个人端无关的编码装配。
- 新建有界 ready/init/abort 工具协议：便于长驻复用，但每次外部操作已有独立执行身份，单次 stdin 与原字节输出足够；复制通用工具框架会增加维护。
- 原生准备继续猜测任意 worker 的依赖：调用方改动最少，但可能选到另一个产品的依赖，也扩大可见根；显式声明使新产物无需旧 Pi 安装。

## 验证

窄用例覆盖无 node_modules 的产物执行、原字节双流与大输出、坏输入/目录身份变化零启动，以及显式根保护和旧依赖缺省；真实 Linux 与独立审查证据见[工单](../../../../.scratch/personal-pi-durable/issues/23-command-worker.md)。

## 后果

单次 worker 避免旧 SDK 与工具循环；命令信号按 Shell 惯例映射为 `128 + signal` 退出码，worker 真正被平台终止仍由进程 signal 表示。worker 的退出不证明后代退出或命令效果，stdin 提交与 OS 外部执行不原子。durable 权限、操作回执、未知暂停、占用与完全访问仍需独立接入，本决定不能作为开放模型命令的依据。
