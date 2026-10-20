# Agent Note: Coding Agent 的原生受限执行与 macOS 未核实后代保留占用

Status: implemented

部分取代：[个人正式入口与旧装配退出](../simplification/2026-10-18-personal-product-entry.md)使个人命令沿独立 durable 接线复用原生原语，Coding 的 ToolRouter/Runtime/worker 与平台核实约束保持；本篇共同正式 CLI 声明不再描述个人入口。

需跨进程核实的 Linux 执行另用[持久认领](2026-10-17-native-linux-execution-identity.md)固定原单元和 cgroup；本篇 Coding 默认 launcher 及其生命周期保持。

扩展与部分取代：[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)将本篇原生边界用于个人产品，接管其常驻前提、正式入口和 Docker worker 交付清理；平台机制、保护范围与 macOS 未核实后代的取舍仍由本篇持有。

## 问题

Coding Agent 的受限任务需要直接使用开发机工具链，并让路径、ACL 与目录身份保持宿主语义。[按任务容器](2026-09-20-tool-worker-per-task-container.md)在 macOS 依赖 Docker Desktop 的 Linux VM，另有挂载权限与 inode 重新编号的差异；更换容器运行时仍保留这些代价。原生执行必须继续隔离后台数据、模型凭据、控制面、其他任务和未授予资料，并覆盖主任务、SubAgent 与 worktree 创建、共享 Git 只读访问及汇总。

平台能力与部署缺项必须分开判定。Seatbelt 文件规则要匹配真实路径，`/tmp` 与 `/private/tmp` 的别名能使错误规则静默失配；Ubuntu 24.04 的 userns 限制按可执行文件路径匹配 AppArmor profile，临时目录中的 bwrap 没有 `/usr/bin/bwrap` 的许可。两类环境错误都不能作为平台机制不可用的依据，具体负例和更正保存在[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md)。

macOS 没有本实现可用的不可逃逸内核进程成员集合：`posix_spawn` 属性位可换 PGID/SID，`kqueue NOTE_TRACK` 返回 ENOTSUP，launchd job 消失不证明换会话的后代退出。Linux 的 PID namespace 与 cgroup 提供内核成员关系；macOS 需要在非特权运行与确定回收之间作取舍。

## 决定

原生启动器直接接入现有 `WorkerLauncher`，不引入跨平台 sandbox runtime。`confirm`、`auto-review` 与 Plan 使用同一受限边界，worker 协议、SDK 工具、审批单次消费、操作账本和任务收尾保持原有归属。原生执行缺能力时明确失败，不改用 Docker、local 或后台自由执行；完全访问仍经受保护固定入口使用专用执行账户。

两平台的 native worker 以实际宿主开发账户运行，保留宿主 UID/GID、补充组和 ACL，不借用容器 UID，也不调整工作区归属。Linux user namespace 中的权限范围来自只读挂载、完整 namespace、capability 删除和 seccomp。工作副本权限预检按宿主账户 `accessSync`，与 Docker Desktop 的 VM 例外分别判定。

### 共享授权、身份与临时资料

- `LaunchSpec` 是平台启动的授权来源。工作区必须带宿主钉定的 dev/ino；工作区、授予与只读根使用已核实真实路径，别名输入与身份不匹配在创建单元前拒绝。只读祖先内嵌读写授权也拒绝，不能由挂载或规则顺序扩大权限；可写工作区内的只读子根保留只读约束。持久登记目录的跨启动复核与当前启动身份转换见[登记设备号](../bug-fix/2026-10-18-directory-device-number.md)。
- 保护范围共用 `approved-ops.ts` 的物理身份判定：除文本路径外，以 dev/ino 比对保护根及目标的祖先，拒绝保护根的挂载别名与物理别名；目录授权也反向排除保护根祖先。原生授权、运行依赖、工作区及已批准文件操作使用同一判定。宿主按目标及祖先 inode 核对保护树内子对象，拒绝其 bind/hardlink 别名；原生运行依赖按保护根[批量核对](../bug-fix/2026-10-18-batch-native-protection-checks.md)，单次同步调用内复核固定身份与已观察目录变化。
- Seatbelt 与只读 bind 都无法识别预存文件硬链接的另一可写名字。`assertNativeFileLinks` 遍历显式授权树，按目录 dev/ino 去重；文件以父目录 dev/ino 加真实 basename 识别独立目录条目，不能把 `/System/Volumes/Data` 的目录或文件别名重复计数。显式文件名必须精确出现在父目录 readdir 结果中，APFS 大小写或 Unicode 等价名字不是第二个授权条目。对 nlink 大于 1 的文件，同一对象所有条目都在授权内且访问等级一致才接受；nlink 超过已授权条目数、同一目录/条目/文件的只读与读写冲突或复核变化都拒绝，同权限授权内的正常硬链接保留。启动与每调用前重核，失败先停止旧单元再拒绝调用；此显式授权遍历不扫描保护目录、凭据树或整个宿主，也不跟随符号链接递归；保护树身份核对由上一条独立执行。成本随每次调用的授权树条目数、授权范围数与硬链接复核增加，大仓库的这项遍历不能记作常数成本。
- Runtime 下发代码、后台数据、agent 与控制面保护根。代码根仅对可信构建的 `worker/worker.mjs` 与实际运行依赖 `node_modules` 开放只读例外；不开放整个源码根、整个 HOME 或 `/System/Volumes/Data`。工具安装版本、实际动态库与必要 SDK 只读进入边界；未知安装布局只提供实际可执行文件，不能从 bin 向上猜一个资料父目录。
- PATH 包含实际 Node、选定宿主工具目录与系统工具目录。工具符号链接和动态库别名保留来源与真实目标，不把 `/opt/homebrew` 或用户自定义工具父目录作为通用可读根。macOS 提供系统只读根、选中的 Xcode/CommandLineTools 安装根与精确许可 plist，不开放整个 `/Applications` 或 `/Library/Developer`；`GIT_CONFIG_NOSYSTEM=1` 防止工具读取系统 Git 配置。
- `ToolWorkerHost.startUnit` 在 native launch 前为全部 grantedPaths 保存 realpath/stat 得到的 dev/ino，不改变公开 LaunchSpec 字段。`call` 每次合并工作区、带身份的只读根和全部授予身份重新核实；只读或读写授予被替换也必须阻止调用，不能只检查工作区。身份变化先请求停止旧单元，再拒绝发送该调用；停止结果仍留在同一宿主记录，不能因目录变化或句柄关闭释放占用。worker init 另核实工作区与只读根 dev/ino；只有实际 macOS container 路径保留 Docker Desktop 的 inode 例外。
- 每个执行单元有随机 0700 临时目录与独立 HOME/TMPDIR。worker 不继承凭据、代理、SSH agent、控制面或 systemd bus 环境；宿主只允许固定 `GIT_CONFIG_*` 聚合包。worktree 的 patch、numstat 和错误资料用该 TMPDIR 下 `mktemp -d` 随机目录，不用共享的固定 `/tmp/ruukoto-integrate.*`，不在 EXIT trap 中提前删除。已核实停止才删除单元临时资料；停止未核实时连同目录占用保留。

### Linux：完整 namespace、BPF 与 cgroup

工作进程由 `systemd-run --user --scope --property Delegate=yes` 启动 bwrap。`--unshare-all --die-with-parent --new-session --clearenv --cap-drop ALL` 提供文件、PID、网络与 IPC 等隔离；基础根、`/tmp` 与 `/dev` 只读，只有授权读写范围和单元临时目录可写。`/proc` 只见沙箱 PID，设备范围由 bwrap 的 `--dev` 提供，Git 等工具可使用 `/dev/null`。

网络 namespace 不能独自隔绝已 bind 的宿主文件路径 Unix socket，因此还装载 syscall BPF。过滤器支持 Linux x64 与 arm64，核实 audit architecture，拒绝另一 ABI 与 x32；禁止 `socket`、`connect`、`sendto`、`sendmsg`、`sendmmsg` 和 `io_uring_setup`，覆盖 TCP/UDP、abstract 与文件路径 Unix socket。保留 `socketpair` 供 libuv 子进程 stdio，但不允许其绕过发送规则。bwrap 消费并关闭过滤 FD，可信 Node 写启动标记后关闭标记 FD，再加载 SDK，工具代码不继承宿主附加 FD。

Linux 需要正式 `/usr/bin/bwrap`、cgroup v2、可创建并委派的 user scope，以及可写的该 scope `cgroup.kill`。Ubuntu userns 加固开启时还需要加载匹配 `/usr/bin/bwrap` 的 AppArmor `userns` profile；包安装本身不能证明该许可生效，不能全局关闭 `apparmor_restrict_unprivileged_userns` 或改 setuid 来绕过前置。启动器核实真实受限 Node 的标记、user scope 身份和 cgroup 停止能力。

停止使 PID namespace 拆除，并对精确 scope 的 cgroup 发起 `cgroup.kill`、systemctl kill/stop；成功查询单元已退出、宿主启动进程已退出且 cgroup 无成员后才返回 true。查不到可信 scope/cgroup 身份、查询失败或成员状态不明都不能算退出。

### macOS：Seatbelt 与宿主身份监督

worker 经 `sandbox-exec` 的 deny-default Seatbelt 策略启动。真实工作区与读写授予可写，只读授予与资料根禁止写，网络、外部 Mach/共享内存 IPC 与后台进程信息默认拒绝。只提供运行所需文件读取与祖先元数据；`literal "/"` 的读取用于 dyld 启动，不开放根的 subpath；`literal "/var"` 元数据供开发工具选择器解析别名。直接 `setsid/setpgid` syscall 被拒，但不把它当作阻止所有 posix_spawn 属性脱离的保证。

宿主 C 监督器在沙箱外运行，不引入 root 或专用 UID。它用 libproc flavor 18 取得 BSD 与 unique 身份，检查 192 字节 ABI；寿命由 PID、微秒出生时间与 uniqueid 共同判定，exec 后重新取得 pidversion。无结果的查询失败最多对同 PID 重查三次，间隔请求休眠 1ms，不保证精确墙钟；只有完整合法身份或明确 ESRCH 可以结束核实，持续失败、短结构、错 PID 与零 uniqueid 仍为未知。重查不清除既有 uncertain、不改基线、成员、新孤儿或观察间隔判定。信号通过 `proc_signal_with_audittoken` 在内核内核实 PID 与 pidversion，避免查询与发信号之间误杀复用 PID。启动前 `--check` 用错误自 pidversion 验证内核拒绝信号；ABI 或原子信号能力不可用时不启动工具单元。结构与 flavor 依据 [Apple proc_info_private.h](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info_private.h)，具体运行前置由本机预检证明。

监督器在 fork 前保存同 UID 身份基线，child 在私有 gate 上等待登记；释放前创建独立会话并关闭状态 FD、控制 FD 与 gate，worker 只继承 0/1/2。launcher 同时等监督器 started 和尚未加载工具的 Node 写入本单元唯一启动文件，不用 worker 可继承的宿主状态通道冒充受限启动成功。

任务存活期约每 10ms 采集同 UID 进程，按当前父 uniqueid 与已观察到的原组成员累计寿命身份；当前父 uniqueid 会随收养改变，不能作为不可变原父。未知新寿命以 fork 单调分配、exec 保留的 uniqueid 与 root 初始 uniqueid 比较，不用可能回拨的墙钟判出生先后。停止对精确成员发 TERM 再 KILL，不用未经身份核实的 killpg。停止后 100ms 连续完整快照用于收敛；已知成员逐个查询，不能只因它没出现在 UID 列表就算退出。超过 250ms 的观察空档、身份/信号失败或最终未知新孤儿使结果保持 false。

新同 UID 孤儿若不在基线或已归属集合内，不发信号、不按命令名认领。只排除当前父 uniqueid 等于启动前 PID 1 uniqueid、且内核保存的原父 pidversion 同时等于 PID 1 pidversion 的进程；仅当前父为 launchd 不足以排除收养后代。`p_orig_ppidversion` 在 fork 时保存原父的当时版本，exec 复制并保留；`p_puniqueid` 指当前父，收养后会改变。字段来源见 [XNU proc_info.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)与 [kern_fork.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_fork.c)。

PID 1 与 worker 的 UID 不同；flavor 18 对跨 UID 身份查询返回 EPERM，不能拿它作 PID 1 预检。监督器用可跨 UID 的 flavor 17 读完整 56 字节 unique 信息，不查询 argv、环境或凭据；读取失败仍禁用排除，保持未核实。真实只读复核中，PID 1 uniqueid=1/pidversion=615，导致两次误拒的 mdworker_shared 同样保存原父版本615；这是内核身份匹配，不是按名称豁免。原 false 日志保留，修复不改写其结论。

pidversion 来自 fork/exec 共用的 32 位全局原子递增计数器，会回卷，不能宣称永久全局唯一；只凭一个原父版本扩大到任意预存外部父，证据不足。PID 1 排除仅在 root 初始无符号版本大于 PID 1 快照版本时启用。采样看到非 baseline、出生不早于 root 或属于已知成员的寿命，其当前无符号版本低于 root 初始版本时，永久标 `pidversion_counter_wrapped` 并返回未核实；baseline 与 fork 之间出生的外部进程不因版本较低误拒。`--check` 自检 UINT32_MAX→1、正常顺序与有符号边界，只证明比较算术，不强迫真实内核回卷。未观察到回卷不构成跨长期永久唯一保证，观察空档或身份不明照常 false；不增加通用外部父白名单，不把轮询提升为确定内核成员关系。计数器依据 [kern_exec.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)。

macOS 的轮询不是内核成员集合。短命中间父进程可在一个间隔内退出，集合外 posix_spawn 后代可以继续运行；无法核实必须报告并保留占用，不要求该类残留已被杀死。它仍受继承的文件和网络约束，但可以继续消耗资源或改写已授权工作区，因此不能在该目录建立替代执行环境。helper 异常退出无停止回执也按未核实处理，不能以它自己的 PID 消失代替后代退出。

### 失败归属与产品范围

`ExecutionError` 以 code 传递失败；`execution_unavailable` 另带 `binary_missing`、`policy_missing`、`sandbox_rejected` 或 `worker_failed`。可信 Node 启动标记区分进入沙箱前拒绝与 worker 阶段失败，不解析 stderr 文案。单元创建后的错误必须携带 `ExecutionError.unit` 交出停止身份。

平台启动器只提供停止结论；[共享生命周期](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md)让 ready/init 失败、启动取消、并发及重复停止、普通任务和临时 worktree worker 共用该结论。false 或异常保留占用、已知结果和现场，发布 `task.tool_process_unreaped`；模式或授予变化的替代环境以 `mode_switch_unverified` 拒绝，效果未知操作不重放。

本决定部分取代[按任务容器](2026-09-20-tool-worker-per-task-container.md)对 Coding Agent 选择 native 时的受限后端规则；原篇的完整工具工作进程、有界协议、专用执行账户与个人 Agent 容器部署继续成立。宿主永不直接执行仓库 Git；创建、只读共享 Git 和汇总沿用[worktree](2026-10-04-subagent-worktrees.md)与[改动汇总](../feature/2026-10-05-integrate-worktree-results.md)的归属、权限及成果保留。

## 正式入口与迁移

Coding Agent 能力声明固定默认 native 且只允许 native。CLI 参数与 `RUUKOTO_EXECUTION_BACKEND` 中显式 container/local 拒绝，并提示改为 native 或移除覆盖，不自动转换配置；库层测试可注入 local。日常按需后台、显式 server 与开发入口使用同一声明，不能从配置页面、模型参数或任务属性改写。

升级先停止旧后台及执行单元，再替换检出、安装依赖、重建产物并移除旧参数或环境覆盖，使用原档案重新打开入口。历史会话、工作副本、审批、产物和异常占用保留，不重建数据目录、不在线替换活动任务执行环境；缺原生能力仍明确失败。个人 Agent 保留原 container/systemd 部署，两个产品独立升级。

平台探针、预存别名反例、SDK worker、SubAgent/worktree、审批与恢复证据分别记录，不能用一类通过代替另一类，也不把 macOS 未核实残留描述为完整回收；具体验收归[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md)。

## 既有笔记审计

- 按任务容器：部分取代其 Coding Agent 后端选择，原决定保持，互链；个人产品容器、协议与完全访问独立保留。
- 停止未核实结果保留：部分重叠，本篇提供平台停止能力，原篇持有结论缓存、传播、终态事务与恢复，互链。
- 两个产品、SubAgent worktree、改动汇总：部分重叠，原篇继续持有产品能力、写入目标和成果语义；这里只记录后端、宿主身份与 TMPDIR，通过具名链接关联。
- 检索命中的工作委托、SubAgent 重启恢复、消息、长期授权、分支快照与服务 helper：与本篇的后端选择无关；其身份、审批与恢复约束沿用，不另开副本或吸收。
- proposed 树中的本提案移到 implemented，日期不变；没有其他重复提案需要拒绝或归档。

## 备选方案

- Linux Landlock：非特权可用、继承到脱离后代，不需要 namespace 和管理员 profile；实测 ABI 4 拒绝外部文件与 TCP。UDP、abstract Unix socket、宿主 PID 和 SysV IPC 的缺口不能满足默认无网络与 IPC 隔离，故不作为降级后端。
- macOS 专用 UID 加特权助手：UID 可提供不可逃逸成员范围，能换 UID 时可确定回收。它需要 root 守护进程或 setuid 助手，并改变工作副本归属；拥有者选择非特权轮询与未核实保留占用。接受前提变化时优先重访此方向。
- macOS 只用进程组、launchd job 或 kqueue：机制现成，回收实现小。真实 posix_spawn 逃出 PGID/SID 后心跳仍增长，bootout 成功也不代表停止，NOTE_TRACK 不支持；这些不提供本任务所需的停止事实。
- 全局关闭 userns 加固或把 bwrap 设为 setuid：部署配置少，能绕过 namespace 前置。前者扩大整机权限，后者增加特权入口且损失部分 bubblewrap 特性；按固定可执行路径授予 profile 的范围更小。
- user systemd 的 `IPAddressDeny=any`：和 cgroup 停止共用机制，配置只有一行；非特权 user 单元实测仍可联网，不能代替 namespace 与 BPF。
- Podman、Apple container、lima 或保留 Docker Desktop：容器边界和停止已有真实证据，复用启动器成本低；macOS 仍需 VM，无法消除本决定的工具链、权限与 inode 差异。个人 Agent 继续使用容器，不受此选择影响。
- 放开整个工具安装父目录或拥有者 HOME：能自动兼容未知工具布局；同时会把资料与凭据带入边界。选择明确安装版本和实际动态库，无法核实依赖时拒绝并由拥有者调整安装或授权。

## 后果

收益是原生任务使用实际宿主工具和目录身份，共享 worker、审批与占用机制无需第二套生命周期；Linux 的 PID namespace 与 cgroup 能核实换组后代。代价是 Linux 增加一次性 bwrap/profile、user systemd 与 cgroup v2 前置，macOS 需要 C 构建及 libproc 私有 flavor ABI 预检；自定义工具布局可能明确失败，不能以开放整个资料父目录提高兼容性。

macOS 未知残留可能继续写工作区和消耗 CPU/内存，保留占用会阻塞新工作，也可能因无关同 UID 孤儿保守误拒。轮询频率不能消除竞态；缩短间隔或命令名过滤都不能提升为确定回收。`sandbox-exec` 已弃用，系统移除或策略改变时该平台明确不可用；若确定回收成为硬要求，重访专用 UID/特权助手或停止提供该平台受限执行，不自动回退。

证据只覆盖当前 macOS 27 arm64 与 Ubuntu 24.04 x64；Linux arm64 BPF 分支有定向判定测试，没有本轮真实平台验收。其他发行版、LSM、旧 AppArmor ABI 与宿主工具布局要分别验证；不能把本机通过推广为全平台保证。已授权工作区和只读依赖中的既有资料仍可读取，沙箱不识别内容是否为秘密。

## 验证

- [macOS 88 项回执恢复报告](../../../../verification/foundation/results/native-macos-stage1-88-recovered-report.md)：从保存的原始日志恢复 88/88 回执，不补填缺失的环境元数据；覆盖虚拟文件与别名、网络/IPC/FD、工具链启动、真实后代心跳与生命周期。后续[90 项报告](../../../../verification/foundation/results/native-macos-stage1-report.md)的只读授予与共享 Git 创建硬链接均 started 后 EPERM；整体 88/90，另两项因为未知同 UID 孤儿保守拒绝，不改写为全通过。STOPPED 只证明夹具的累积集合，集合外残留单列。
- [Linux 当前平台报告](../../../../verification/foundation/results/native-linux-current-report.md)：52 项真实边界通过，另有 2 项有效宿主对照；完整 namespace、文件路径 Unix socket BPF 拒绝、真实编译、脱离后代和 cgroup.kill 分开证明。
- 预存硬链接的原始失败保留：[macOS 0/2](../../../../verification/foundation/results/native-macos-preexisting-hardlink-report.md)与[Linux 2/4](../../../../verification/foundation/results/native-linux-preexisting-hardlink-report.md)，其中 Linux 两个通过项只证明创建链接被拒，不覆盖预存别名。产品授权 guard 的拒绝另由定向测试和真实 worker 验证，不把候选策略失败回填成通过。
- [Linux 正式 scope 报告](../../../../verification/foundation/results/native-linux-scope-report.json)：3/3，活动 detached 后代停止核实 true；快速退出与 bwrap 前缺入口在未取得可信 cgroup 时 false，不因启动进程退出释放占用。
- `test/101-native-execution.test.ts`：BPF 的 x64/arm64、另一 ABI/x32、规范化/物理保护根、嵌套只读、环境、临时目录与模式接线；硬链接回归包括 Data 目录/文件别名和大小写别名不能重复计数，它不代替 OS 策略拒绝证据。
- `test/101-native-macos-helper.test.ts`：真实 helper ABI 与错误 pidversion、FD 关闭、受限 Node 启动、累积逃离后代停止及未知孤儿 false/不误杀；5 项通过。
- `verification/smoke/smoke-26-native-worker.mts`：两平台各 10/10，报告为 [macOS worker](../../../../verification/foundation/results/native-macos-worker-report.json)与[Linux worker](../../../../verification/foundation/results/native-linux-worker-report.json)；真实 read/edit/write/bash、宿主工具、虚拟凭据/控制面/网络拒绝、授权重建、启动取消、工作区及读写授予目录替换、预存硬链接和物理别名 guard。正式按需入口在没有 execution 参数/环境覆盖且 Docker 入口不可用时使用默认 native。模型模拟，文件与 OS 边界真实；这份 smoke 不验证审批单次消费。
- `verification/smoke/smoke-26-native-worktrees.mts`：两平台各 8/8，报告为 [macOS worktrees](../../../../verification/foundation/results/native-macos-worktrees-report.json)与[Linux worktrees](../../../../verification/foundation/results/native-linux-worktrees-report.json)；真实副本创建、共享 Git 只读、改动汇总、幂等、冲突、取消、恢复与并行临时资料，停止和清理核实完成。
- 审批消费的共享回归用 `test/08-approvals.test.ts`、`test/22-auto-review.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`；真实个人容器路径另有 `smoke-04-desktop-execution.mts` 6/6。升级基点为同协议的 `5e84daa`，`smoke-24-release-acceptance.mts --upgrade-only` 4/4；历史不兼容基点的失败记录保留，不能把它称为升级通过。

## 适用范围

两个产品的正式入口均默认且只接受 native；个人后台的系统 service、user manager、bus 与 cgroup 常驻前提由[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)持有。`ToolRouter.launchSpecFor` 和临时 `Runtime.executeWorkCopy` 统一下发宿主 dev/ino；`WorkCopyManager` 权限预检统一使用实际账户的 `accessSync`，包括补充组与 ACL，不保留容器 UID/GID 或 Docker Desktop VM 例外。本篇原个人容器部署与专用完全访问账户条目按新决定的适用范围解释，平台机制及原始真实验证保留。

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。

[目录保护优化](../bug-fix/2026-10-17-directory-protection-cost.md)为文件树目录列表增加仅遍历目录的批量检查；通用文件保护与本篇原生执行规则继续沿用。

相关未实施工具方案：[文件检索](../../proposed/feature/2026-10-21-controlled-file-search.md)沿用本篇受限范围；[跨轮后台执行](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)另定会话占用与恢复，不改变当前按任务执行的事实。
