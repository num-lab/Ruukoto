# 公开 Agent 项目的原生沙箱：实现与保证范围

研究日期：2026-10-09。本文针对[工单 26](issues/26-native-sandbox.md)的三个问题：macOS 脱离进程组的后代如何停止、Linux 的 user namespace/AppArmor 前置条件如何处理、这些项目提供的边界是否与 Ruukoto 相同。

以下结论来自官方文档和公开源码阅读。没有运行这些项目的完整原生边界探针，没有证明它们在本机或 tx 上通过工单 26 的验收。源码中的停止逻辑、操作系统接口的语义和实际进程全部退出，是三个不同的证据层。

## 结论

这些项目没有统一解决全部问题。Linux 常见实现是 bubblewrap 的 user/mount/PID/network namespace 加 seccomp，依赖宿主允许创建 namespace；Ubuntu 的 AppArmor 拒绝仍要通过安装和系统策略处理。macOS 常见实现仍是 Seatbelt 加宿主进程管理；已核实的公开停止代码没有提供与工单 26 相同的、经过心跳验证的整个执行单元停止证明。

沙箱限制随后代继承，说明后代继续运行时仍受限制；它不直接说明取消后所有后代都已退出。尤其不能把使用 `sandbox-exec`、`--die-with-parent`、`killpg` 或名为 `cleanup` 的函数，当作完整生命周期验收的替代。

| 项目与证据范围 | macOS | Linux | 已找到的停止实现及其边界 |
| --- | --- | --- | --- |
| Codex：官方产品文档及公开 `openai/codex` 源码 | Seatbelt / `sandbox-exec`；支持受限读取配置 | 默认 bubblewrap 加 seccomp，默认独立 PID namespace | 宿主采用进程组信号；macOS 对组信号被拒绝的情况枚举原 PGID 的成员补发。此机制本身未覆盖改 PGID 的后代。Linux 还有 namespace 与内层 fork/wait/signal 机制，需实测取消、父崩溃是否使 namespace init 退出 |
| Claude Code：官方产品文档；Anthropic `sandbox-runtime` 为可核查的公开实现 | Seatbelt；默认广泛读取宿主文件，拒绝规则按配置加入 | bubblewrap、代理桥、可选 Unix socket seccomp；依赖 capability-bearing user namespace | `sandbox-runtime` CLI 对直接 child 发信号；库的清理主要处理挂载与代理等资源。公开库不能代表闭源 Claude Code 上层全部停止行为 |
| Gemini CLI：官方文档及公开 main 源码中的工具沙箱 | Seatbelt，允许工作区和工具链读取；基础策略也开放若干较宽系统目录 | `--unshare-all`、`--die-with-parent`、独立 `/proc`；授权网络时 `--share-net` | Unix 停止先用 `pgrep -P` 递归取后代快照，再对组与列出的 PID 发信号。能补足部分脱离组的情况，快照本身不能证明 fork、重新托管和父崩溃竞态全部受控 |

## 版本固定与资料来源

此次读取的公开源码 HEAD 如下。链接使用固定 commit，后续 main 的变化不属于本文结论。

| 仓库 | HEAD |
| --- | --- |
| `openai/codex` | `9b738582b13c2cdbeff54af0afd04c50c3e7ba09` |
| `anthropics/sandbox-runtime` | `3f0bad7345238f47736435e3f2b064399c1cad74` |
| `google-gemini/gemini-cli` | `44d764ee579610bf73c43107f5e0422cd92588b9` |

官方产品文档为研究当日实际获取的页面，不保证与上述开发分支、当前安装的发行版完全同步。OpenAI 原 `developers.openai.com` 页面已重定向，本文引用实际内容所在的 `learn.chatgpt.com` 官方页面。Claude Code 文档与公开 runtime 源码也分别列证，不能把二者直接视作同一发行版本。

## Linux：宿主策略仍是前置条件

Codex 官方文档明确优先使用 PATH 上的系统 bwrap，没有时使用随包 helper。Ubuntu 25.04 的系统 profile 和 Ubuntu 24.04 的 profile 安装、复制与加载，是文档列出的 user namespace 处理方式；文档还列出全局 sysctl 作为备选。这说明产品没有通过普通应用代码绕过 AppArmor。随包路径和 `/usr/bin/bwrap` 是否匹配系统 profile，必须分别核实。[OpenAI 官方 Sandboxing](https://learn.chatgpt.com/docs/sandboxing.md)

公开源码进一步确认，Codex 会对缺少 bwrap 或无法创建 user namespace 提前给启动警告；默认显式创建 user、PID、IPC namespace，限制网络时创建 network namespace。受限文件执行要求 bubblewrap，旧 Landlock 路径因不能隔离 app-server Unix socket 而被拒绝，不能作为相同保证的替代。[Codex Linux sandbox README](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/README.md)、[bwrap 参数构造](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/src/bwrap.rs#L285-L401)

Anthropic runtime 的 README 同样明确 Ubuntu 24.04+ 的 `kernel.apparmor_restrict_unprivileged_userns` 会影响所需权限，要求修改 sysctl 或给相关程序提供允许 `userns` 的 profile。它的 Linux 路径不只有外层 bwrap：Unix socket 隔离 helper 还要创建嵌套 user、PID、mount namespace，所以只证明 `/usr/bin/bwrap` 能启动不够。[runtime 前置条件](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/README.md#L652-L662)、[外层和嵌套 namespace 构造](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/sandbox/linux-sandbox-utils.ts#L3478-L3521)

Claude Code 官方文档给出专用 AppArmor profile：附着 `/usr/bin/bwrap`，带 `flags=(unconfined)` 并允许 `userns`。公开仓库的兼容性报告则说明，发行版 `bwrap-userns-restrict` 对 bwrap 子进程施加的限制可能阻断 runtime 的嵌套 helper；这些是报告环境中的现象，尚未在 tx 复现，不能推导每个 profile 都能修好。[Claude Code 官方 Sandboxing](https://code.claude.com/docs/en/sandboxing.md)、[Anthropic runtime issue 429](https://github.com/anthropics/sandbox-runtime/issues/429)、[Claude Code issue 87680](https://github.com/anthropics/claude-code/issues/87680)

Gemini 的 Linux 工具沙箱在源码中通过 Shell `exec bwrap` 启动系统程序，本文检查的实现文件没有提供 AppArmor 例外的安装或自动提权。它仍受同一宿主 namespace 前置条件限制。[LinuxSandboxManager](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/linux/LinuxSandboxManager.ts#L296-L342)

对 Ruukoto 的影响：正式路径 bwrap 加专用系统许可是一条可验证路线，不能用全局关闭 AppArmor 的结果冒充原有系统保护下的通过。tx 必须重新跑实际 namespace 启动和完整探针，尤其要检查 helper、网络回环设置和 Unix socket 边界。

## Linux：进程域、网络和 Unix socket 分别处理

Linux PID namespace 提供的关键机制是：该 namespace 的 init 退出时，内核杀死该 namespace 中剩余进程；`setsid` 和改 PGID 不会把进程移出 PID namespace。最终成立的前提是整个不可信后代都留在受控 namespace 中，并且停止路径确实使 init 退出。用户空间发过信号并不自动证明这一条件。[Linux PID namespace 接口文档](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)

Codex 的内层 helper 在应用 seccomp、核实 capabilities 后 fork 用户命令，转发信号，同时 `waitpid(-1)` 回收；主命令退出后 helper 随之退出。发送信号时同时面向命令 PGID 和 PID。bwrap 参数包含默认 `--unshare-pid` 与 `--die-with-parent`，形成比单纯 PGID 更强的候选生命周期边界。不过没有运行 Codex 的取消和父崩溃探针，因此本文不把源码结构写成已经通过 Ruukoto 生命周期验收。[内层 fork/wait](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/src/linux_run_main.rs#L198-L282)、[信号转发](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/src/linux_run_main.rs#L900-L935)

Codex 的受管网络路径使用独立 network namespace 加 TCP→UDS→TCP 桥，桥启动后再对用户命令限制创建 AF_UNIX/socketpair。Anthropic runtime 也使用代理与 UDS 桥，并在桥运行后把命令放入嵌套 PID namespace 再应用 seccomp；它额外拒绝可能绕过 `socket(AF_UNIX)` 规则的 `io_uring` 系统调用。两者都表明单独设置代理环境变量或 network namespace 不是完整 IPC 策略。[Codex 网络实现说明](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/README.md)、[runtime Unix socket 说明](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/README.md#L921-L947)

Anthropic 文档明确其 seccomp 不处理继承的 Unix socket FD 或经 `SCM_RIGHTS` 得到的 FD；缺少可用 seccomp helper 时是警告并继续，Unix socket 不受该限制。因此 Ruukoto 仍需最小继承 FD 和缺项拒绝策略，不能只复用同名选项。[runtime 已记录的限制](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/README.md#L472-L482)、[FD 边界说明](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/README.md#L933-L947)

Gemini 源码使用 `--unshare-all` 和独立 `/proc`，授权网络时加 `--share-net`。该文件没有基于域名代理的相同策略；其自制 seccomp 当前只拒绝 `ptrace`，其余允许，没有在这个 filter 中找到 AF_UNIX 拒绝。因此不能声称 Gemini 在所有配置下隔离了暴露在文件树中的宿主 Unix socket。[bwrap 参数](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/linux/bwrapArgsBuilder.ts#L43-L66)、[seccomp filter](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/linux/LinuxSandboxManager.ts#L52-L110)

## macOS：公开停止实现没有给出同等保证

OpenAI 官方文档说明 macOS 使用 Seatbelt / `sandbox-exec`，并对受限读取配置使用平台规则。公开进程管理代码采用独立进程组；macOS 对 `killpg` 权限拒绝的补救是调用 `proc_listpgrppids` 枚举同一 PGID 的成员并逐个发送信号。它不是遍历已经改 PGID 的后代，不能用这段实现解决 Ruukoto 探针里的 `posix_spawn` 逃组案例。这里的判断针对该函数的范围，不是对整个 Codex 产品全部可能路径的否定。[OpenAI 官方安全文档](https://learn.chatgpt.com/docs/agent-approvals-security.md)、[Codex process group 代码](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/utils/pty/src/process_group.rs#L152-L216)

Anthropic runtime 的 macOS profile 允许 `process-exec`、`process-fork`，并允许 same-sandbox 进程信息和信号操作；执行是 `sandbox-exec -p` 包裹 Shell。公开 CLI 对 SIGINT/SIGTERM 调用 `child?.kill`，控制 FD 失效路径也对直接 child 发送 TERM/KILL。库的 `cleanupAfterCommand` 清理 bwrap 挂载，`reset` 清理代理、桥和日志等资源；这些函数名称不能证明任意 macOS 后代都已停止。[Seatbelt profile](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/sandbox/macos-sandbox-utils.ts#L1017-L1026)、[CLI 停止代码](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/cli.ts#L559-L599)、[控制 FD 失败路径](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/cli.ts#L400-L415)、[库清理函数](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/sandbox/sandbox-manager.ts#L2429-L2440)

Claude Code 本身的上层命令管理没有以完整产品源码公开。本文未找到它对脱离 PGID 的 macOS 后代提供整个执行单元退出保证的可核查证据，不能将公开 runtime 的不足直接写成闭源产品一定没有其他措施。

Gemini 的 Unix 停止实现比单纯组信号多一步：先递归 `pgrep -P` 读取后代，向进程组与该快照中的所有 PID 发信号，必要时升级 SIGKILL。不过快照后 fork、父进程在扫描前退出、重新托管后代等情况不能由这段代码排除。主进程的 `isExited` 还决定是否升级信号，本文未实测这些竞态。[Gemini killProcessGroup](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/utils/process-utils.ts#L38-L145)、[Shell abort 调用](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/services/shellExecutionService.ts#L922-L932)

因此，本次没有找到可直接复制并已证明满足工单 26 的 macOS 全后代停止方案。也没有依据断言 macOS 所有原生机制都不可能；合理的下一步是对具体候选任务域或 supervisor 运行同一逃组、心跳和父崩溃探针。

## 安全合同不同，不能以项目采用原生沙箱代替验收

Claude Code 官方文档的默认安全范围明显较宽：沙箱默认关闭；启用后允许读取机器上大部分文件，包括 `~/.ssh`、`~/.aws/credentials`，继承环境中的秘密仍可见。其 Read/Edit/Write/Web 内置工具不在 Bash 的 OS 沙箱边界内。文档提供 `denyRead`、credentials 配置和环境清理来收紧策略；缺 required dependency 或不支持的平台默认仍可不经沙箱执行，需要 `failIfUnavailable=true`。禁止重试到无沙箱的 `allowUnsandboxedCommands=false` 是另一项独立配置。[Claude Code 官方 Sandboxing](https://code.claude.com/docs/en/sandboxing.md)

公开 runtime 的 `generateReadRules` 默认先允许 `file-read*`，再应用拒绝和允许的路径规则。这与工单 26 默认不读取未授权宿主资料的模型不同。[macOS 读取策略](https://github.com/anthropics/sandbox-runtime/blob/3f0bad7345238f47736435e3f2b064399c1cad74/src/sandbox/macos-sandbox-utils.ts#L823-L829)

Codex 支持默认广泛只读及更受限的文件策略，具体边界取决于 permissions 配置；不能把只读挂载等同于无读取权限。Gemini 的 Linux 工具策略从 `--ro-bind / /` 开始，再遮蔽 forbidden 和秘密文件，意味着没有被遮蔽的宿主路径仍可读。[Codex 文件策略说明](https://github.com/openai/codex/blob/9b738582b13c2cdbeff54af0afd04c50c3e7ba09/codex-rs/linux-sandbox/README.md)、[Gemini Linux 挂载](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/linux/bwrapArgsBuilder.ts#L43-L66)

Gemini macOS 采用 deny-default 和具体读路径，但基础 profile 导入 `system.sb`，并广泛开放 `/System`、`/Library`、`/opt/homebrew`、`/private/var/run`、`/private/var/db`、`/private/etc` 等。路径生成还允许 Node 安装根和 PATH 目录，`bin` 目录扩大到父目录。它解决宿主工具链兼容性采用的读范围，仍须按 Ruukoto 的控制面和资料授权要求重新审查。[Gemini 基础 profile](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/macos/baseProfile.ts#L14-L23)、[基础读取规则](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/macos/baseProfile.ts#L139-L157)、[工具链路径](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/packages/core/src/sandbox/macos/seatbeltArgsBuilder.ts#L109-L140)

Gemini 官方文档区分工具级沙箱与整个 CLI 进程沙箱；工具级边界保留 UI、配置等宿主功能，并可以关闭。这里比较的是所列源码的工具路径，不把 Docker/Podman/runsc 等全进程运行选项的保证套在它上面。[Gemini 官方沙箱文档](https://github.com/google-gemini/gemini-cli/blob/44d764ee579610bf73c43107f5e0422cd92588b9/docs/cli/sandbox.md#L267-L289)

工单 26 要求 read/edit/write/bash 的整个 worker、默认拒绝未授权宿主读取、最小环境与继承 FD、控制面隔离、能力缺失明确拒绝，以及整执行单元停止后才能释放占用。其他项目的用户体验、默认读范围、降级策略和公开停止实现与该合同并不一致。可复用 namespace、代理桥和 syscall 过滤的具体方法，但这些差异仍必须通过 Ruukoto 自己的真实探针和产品测试处理。

未运行第三方项目的真实边界探针，未修改 AppArmor、sysctl、正式后端或现有任务状态。本文是方案比较，不能作为任何第三方产品或 Ruukoto 已通过安全验收的声明。
