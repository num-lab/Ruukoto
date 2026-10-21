# Agent Note: 工具执行放进边界内的工作进程，受限任务按任务建容器，完全访问用专用执行账户

Status: implemented

原编号：ADR 0004

部分取代：[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)接管个人产品的受限后端、目录身份、临时空间与交付入口；本篇保留完整 worker、有界协议、审批和停止原则的理由。下文容器参数与专用执行账户是原决定的历史方案，不表示当前仍有这些启动器。

Coding Agent 的受限后端由[原生执行沙箱](2026-10-10-native-execution-sandbox.md)接管；完全访问由[当前账户决定](../feature/2026-10-12-full-access-current-account.md)持有。本篇原决定、备选理由和真实历史验证保留。

## 问题

[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)要求对文件、命令、网络和凭据访问施加技术约束，并要求任何模式下的项目命令都不能冒充拥有者。编码工具 read/edit/write/bash 由模型驱动，能运行自由 Shell 及其子进程。如果工具在后台进程里执行，它就拿着后台的身份：模型凭据、数据库和控制面全都够得着。如果宿主只把上游工具的底层读写换成受限实现，路径解析仍发生在边界外：pi `0.85.1` 包内的 `read` 在调用自定义 `ReadOperations` 之前，会先经 `resolveReadPathAsync()` 调用宿主的 `fs.access`。

受限执行环境如果跨任务复用，前一个任务的临时挂载、环境变量、残留进程和一次性批准换来的额外能力，都会带进后一个任务。完全访问不经逐次确认，它运行在哪个系统身份下，决定了任务能不能读到拥有者的认证材料。越界操作经审批后执行，如果批准能重复使用，或者执行参数能在批准后被替换，审批就失去意义。执行环境缺失时如果悄悄换一种方式执行，拥有者会以为任务受限，实际却不受限。

## 决定

- **编码工具的完整执行在工具工作进程内。** read/edit/write/bash 的全部执行，包括上游工具内部的路径解析和 Shell 子进程，都在独立的工具工作进程（`packages/agent/src/tool-worker/`）里完成；SDK、模型调用、审批与持久化留在后台。宿主不替工具先解析路径再委托，因此不存在边界外的夹缝。工作进程只执行这四种工具（其余名字一律拒绝），只接受工具调用并返回数据，拿不到审批、模式切换或控制面凭据；不加载项目自动发现的可执行扩展。参数经结构化消息传递，从不拼进启动器的 Shell 命令。模型请求由后台用后台的模型凭据发送，项目 Shell 不继承这条网络通路和这些凭据。工作进程的环境是最小环境：不传凭据、SSH agent、代理配置与 `RUUKOTO_*` 控制面变量。
- **进程间是一条有界消息协议**（`packages/agent/src/tool-worker/protocol.ts`）：stdio 上按换行分帧的 JSON。后台发 `init`、`tool_call`、`abort`、`shutdown`，工作进程回 `ready`、`data`、`result`、`fatal`。单帧上限 `MAX_FRAME_BYTES` = 4 MiB，正文数据按 `DATA_CHUNK_BYTES` = 512 KiB 分块并以 base64 传输；写入侧有背压，调用有超时。关联键是宿主分配的操作 ID（`opId`），模型生成的 SDK 调用 ID 只供上游工具内部使用，不作身份。宿主工具一律声明 `executionMode: "sequential"`：工作进程按「工具名 → 当前调用」关联原始输出流，同一轮并发的同名调用会串流。
- **正文捕获在工作进程侧完成。** 工作进程经 `BashOperations.onData` 和文件 Operations 包装器，在上游工具截断之前把原始输出与文件正文流回后台；后台先存为任务产物，再生成限长的模型视图，并在工具结果里附产物引用。
- **请求确认与自动审查模式在按任务建立的 Linux 容器内执行**（`createContainerLauncher`，`packages/agent/src/execution/launchers.ts`）。两种模式共用同一受限边界，见[自动审查模式](../feature/2026-09-22-auto-review-mode.md)；Plan 会话的任务固定为自动审查，见 [Plan 会话模式](../feature/2026-10-08-plan-session-mode.md)。容器参数：
  - 固定镜像 `ruukoto-worker`（`RUUKOTO_WORKER_IMAGE`，缺省 `ruukoto-worker:latest`；由可信身份按 `deploy/worker-image/` 构建，固定 pi `0.85.1` 依赖，镜像不内置特权入口）；
  - 非 root：`--user <uid>:<gid>`，缺省 1000:1000。原生 Linux 的 bind mount 不做 uid 映射，部署经 `RUUKOTO_CONTAINER_UID/GID` 固定为拥有者的 uid/gid，才能写工作区；
  - `--cap-drop ALL`、`--security-opt no-new-privileges`、`--read-only` 基础文件系统、单独可写的 `--tmpfs /tmp:rw,nosuid,size=64m`、`--network none`（默认无网络）；
  - 只挂载授权工作区与拥有者为该任务显式授予的路径（只读授予加 `:ro`），以及宿主钉定的只读根（SubAgent 限定的资料范围、worktree 的共享 Git 目录）。挂载一律按宿主原路径（`-v <p>:<p>`，工作区同时是工作目录），系统提示里的 cwd、拥有者给出的绝对路径与 `request_file_access` 的宿主路径在容器内外一致；挂载点以外的父目录在容器内为空；
  - 不传宿主凭据、SSH agent、代理配置、控制 socket 或容器管理 socket。项目内自带的秘密属于已挂载内容，容器不会识别或隐藏它们。
- **容器按任务建立，结束后回收，不复用给后续任务。** 容器名为 `ruukoto-task-<taskId>-<后台 pid 的 36 进制>`，启动前先清理同名遗留。同一任务内按需启动并复用工作进程，复用键是任务 ID、访问模式与授予路径；模式或授予范围变化时，先停止并核实旧执行单元已退出，再建立新环境。按会话复用会让后续任务继承临时挂载、环境变量与残留进程，单次批准换来的额外能力也不应沉淀进常驻容器：审批需要额外能力时不改动容器的权限，单次文件操作的批准也不会变成后续命令可复用的挂载。工作区文件照常保留。
- **停止针对整个执行单元，核实退出后才释放目录占用。** 停止入口必须停掉整个执行单元（容器、systemd 单元或进程组）并核实已退出；只杀 Docker CLI，或等 Shell 主 PID 消失，都不足以证明子进程已退出。容器的停止是 `docker kill` 加 `docker rm -f`，再成功查询全部容器，确认目标名称不存在；查询失败不能证明退出，cgroup 兜底 `setsid` 与忽略信号的后代。受管执行单元登记表（`packages/agent/src/managed-processes.ts`）记录 `process_group`、`container`、`systemd_unit` 三种可回收身份，外加 `starting` 占位：工作进程就绪之前的启动窗口同样在停止路径的覆盖内。核实不了退出时保留目录占用并报告（`task.tool_process_unreaped`；模式切换时为 `mode_switch_unverified`）。后台崩溃后不假定容器随父进程销毁，重启恢复保留中断任务的占用，见[任务由后台进程持有](2026-09-19-detach-terminal-from-task-runtime.md)。
- **完全访问任务在容器外以专用执行账户运行。** 完全访问任何环境下都不进容器，也不逐次确认，但不以拥有者账户运行：执行账户若能读到 CLI 的授权材料就能冒充拥有者，违反[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)的控制面分离。它也不以后台账户运行。执行账户与拥有者、后台都不同，不属于两者的组。
  - 工作进程由 systemd 以固定执行 UID 启动（`createSystemdLauncher`：`systemd-run --pipe --wait --uid --gid --unit ruukoto-exec-<taskId> --property KillMode=control-group`）。生产经 root 拥有、只放行固定参数的 sudo 包装入口（`deploy/systemd/ruukoto-exec-launch.sh`、`ruukoto-exec-stop.sh`）启动与停止；`RUUKOTO_EXEC_LAUNCH_SCRIPT` 和 `RUUKOTO_EXEC_STOP_SCRIPT` 两个都设置才算配置了该入口。只有后台能调用它，执行账户不能调用，也不能修改其配置。直连 `systemd-run` 只能由代码传入配置启用，不能经环境变量打开。项目命令从不以 root 运行，也不向项目暴露通用的特权启动接口；容器管理权限只留给可信后台。
  - 完全访问提供的是该账户已有的系统权限：不承诺读取拥有者账户的全部文件，也不提供账户内部的文件隔离。执行账户进入工作区靠按工作区配置的 ACL（`deploy/systemd/README.md` 第 7 步），没配 ACL 的工作区在完全访问下工具调用会 EACCES。
- **结构化越界操作的批准只能消费一次。** `request_file_access`（外部文件读写）与 `http_request`（单次 HTTP 请求）的消费资格由 SQLite 条件更新原子校验（`Store.consumeApproval`）：任务仍活动、权限版本匹配（批准记录保存的版本与任务当前版本都等于期望版本）、批准未消费；`consumed_at` 即执行开始。执行参数完全取自审批保存的不可变请求，工作进程或模型不能提交一个批准 ID 后自行替换参数。已批准操作由后台的受信执行器（`packages/agent/src/execution/approved-ops.ts`）完成，不进工作进程：
  - 文件操作逐段 `lstat`、拒绝符号链接组件，最终以 `O_NOFOLLOW` 打开；打开后 `fstat` 的 dev/ino 必须与批准时的对象身份一致，写入前校验原文的 sha256 指纹，变化即失败并要求重新申请；后台数据、服务凭据与控制面目录始终排除。
  - HTTP 请求不自动跟随重定向，也不重试；连接固定到批准时解析出的地址（防 DNS 重绑定）；凭据只在目标主机与预配置的绑定一致时注入。批准一个 HTTP 请求不会给脚本开放网络。
- **缺少执行后端或身份配置时明确失败**，错误码 `execution_unavailable`，不回退到后台账户执行，也不改用其他执行方式。完全访问的执行入口在提交与切换模式时检查，缺失即拒绝，任务不创建。容器运行时是否可用要到启动工作进程时才知道：docker 不可用时任务仍可入队，首个工具调用以 `execution_unavailable` 拒绝，命令不执行。
- **`local` 后端没有隔离**（`createLocalLauncher`：以当前账户 spawn 独立进程组），只用于开发与验证，生效时打印无隔离警告，不能据此宣称受限边界已经生效。各产品的默认值与警告见[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)「后果」。

## 平台范围

[两个 Agent 产品](2026-10-02-two-agent-products.md)要求 ruukoto-code 支持 macOS 与 Linux。上面的 Linux 实现不能直接作为 macOS 受限执行的依据，跨平台实现须另行验证；技术权限边界与禁止静默降级的原则在两个平台上都成立。

- **macOS 的受限执行复用同一容器启动器，跑在 Docker Desktop 的 Linux VM 里。** agent-direction issue 03 用产品真实路径（`createContainerLauncher`、`ruukoto-worker:0.85.1` 镜像、宿主 `ToolWorkerHost`）单独验证过这条路径；agent-direction issue 04 起 ruukoto-code 在两个平台上默认使用容器后端。Docker Desktop 有两处语义差异：挂载权限由 VM 代管，容器 uid 1000 写挂载工作区不受宿主权限位约束；inode 经 VM 重新编号，所以 macOS 上 LaunchSpec 不下发工作区与只读根的 dev/ino，工作进程启动时只按路径复核，目录身份由宿主侧的 `taskWorkspaceFor` 复核承担。工作区须位于容器运行时的文件共享范围内（Docker Desktop 默认含 `/Users`、`/private`、`/tmp`）。
- **macOS 的完全访问没有已部署的执行账户入口。** 它需要本机独立账户加 sudo 固定参数包装，属于拥有者的部署前置，尚未验证；没有入口时完全访问在提交时以 `execution_unavailable` 拒绝。
- **SubAgent 与 worktree 共用受限 worker。** `Runtime.executeWorkCopy` 用临时 confirm 工作进程运行宿主固定 bash；container 配置仍在受限容器内，native 配置走[原生后端](2026-10-10-native-execution-sandbox.md)。副本读写、必要共享 Git 范围与 `safe.directory` 环境仍由宿主固定，新增能力不给执行账户带来新权限。详见[SubAgent worktree](2026-10-04-subagent-worktrees.md)与[汇总 worktree 改动](../feature/2026-10-05-integrate-worktree-results.md)。

## 与原生受限后端的关系

[原生执行沙箱](2026-10-10-native-execution-sandbox.md)部分取代本篇对 Coding Agent 选择 native 时的后端决定。Seatbelt/bubblewrap 直接接入 WorkerLauncher，复用 LaunchSpec、SDK worker、审批、操作账本和共享停止生命周期；其宿主工具链、真实 dev/ino、物理保护范围、每单元 TMPDIR 和 macOS 未核实后代保留占用由新篇持有。完全访问专用账户与个人 Agent 的 container/systemd 部署保持本篇规则。

Coding Agent 正式入口默认且只允许 native，显式 container/local 参数与环境覆盖拒绝并提示迁移；库层测试仍可注入 local。原生两平台真实 SDK worker 与 SubAgent/worktree 的报告、预存硬链接反例和 guard、恢复及共享审批证据分别记在[原生决定](2026-10-10-native-execution-sandbox.md)与[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md)，不能用平台探针数量替代产品验证。共享停止失败的缓存、传播、终态与恢复归[停止未核实结果保留](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md)，它不把 local 提升为隔离后端。

原生选择保留两类防误判依据：Seatbelt 的规则按真实路径生成，/tmp 字串不能代替 /private/tmp；Ubuntu userns 的 profile 按正式 bwrap 路径匹配，临时解包的二进制缺许可不能算平台不支持。原失败记录与更正在[macOS 文件/生命周期报告](../../../../verification/foundation/results/native-macos-report.md)、[launchd 报告](../../../../verification/foundation/results/native-macos-launchd.md)、[Linux 启动报告](../../../../verification/foundation/results/native-linux-report.md)；公开实现比较在[原生 Agent 对照](../../../../.scratch/agent-direction/native-agent-comparison.md)。这些历史证据不覆盖后端接入后的产品验收。

## 关联提案

正常 bash 返回后的后台存活与跨轮执行方向见[后台生命周期提案](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)。提案尚未落地，当前执行边界与任务收尾规则保持本篇及后续有效决定的约定。

## 备选方案

- **宿主先解析路径，只把底层读写和 Shell 换成受限实现** — SDK 导出 `createBashTool` 等工具工厂并接受自定义 `BashOperations` 等执行层，这是上游给的官方缝隙（上游 Gondolin 示例就是这种做法）；这样不用另起工作进程，也不用维护进程间协议。不选，是因为包内 `read` 在调用自定义 `ReadOperations` 之前，仍经 `resolveReadPathAsync()` 调用宿主的 `fs.access`，路径解析会落在边界外；所以把上游工具定义的完整执行整体放进工作进程。（见 [personal-agent issue 03](../../../../.scratch/personal-agent/issues/03-tools-and-access.md) 实施计划 §1，[阶段 0 基础验证结论](../../../../.scratch/personal-agent/foundation-findings.md)「权限边界与 Linux 受限执行」）
- **把整个 pi 会话以 `pi --mode rpc` 放进受限环境** — 基础验证已证明 RPC 模式能跨进程驱动 pi 并从事件流还原回复，当时也把它列为任务进程放进受限环境时的跨进程方式，不必自建工具协议。不选，是因为模型调用要用后台的模型凭据和网络，整个会话进了边界，这些也就进了项目 Shell 够得着的地方，而受限容器默认无网络；改为只把工具执行放进工作进程，SDK、模型调用、审批与持久化留在后台。（见阶段 0 基础验证结论「交互与通信选型」，personal-agent issue 03 实施计划 §1、§3）
- **按会话复用容器** — 阶段 0 拟议的就是 per-session 容器：同一会话的任务共用环境，省去每个任务启动容器的开销。不选，是因为后续任务会继承临时挂载、环境变量与残留进程，单次批准的额外能力也会沉淀进常驻容器；改为按任务建立、结束回收。（见阶段 0 基础验证结论「选定方案」，personal-agent issue 03 实施计划 §3，原决定第 2 段）
- **完全访问以拥有者账户运行** — 阶段 0 的拟议部署：拥有者与运行控制面的后台 UID 不同，内核会拒绝它改写授权状态，任务还能直接用拥有者的全部文件与工具链。不选，是因为这个账户同样能读到 CLI 的授权材料，可以冒充拥有者；agent-direction issue 03 的负向实证是本机 0600 的 `owner.token` 对同 uid 进程 `test -r` 返回 0。改用专用执行账户。（见阶段 0 基础验证结论「控制面身份模型」，personal-agent issue 03 实施计划 §1，[agent-direction issue 03](../../../../.scratch/agent-direction/issues/03-execution-boundary-proof.md) 判定结论第 4 条；这一取舍也记在[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)）
- **执行环境缺失时回退到后台账户执行** — 宿主缺少容器运行时或执行账户配置时，任务照样能跑。不选，是因为后台账户持有数据目录、模型凭据与控制面材料，直接用它跑工具，任务就能读到全部凭据，拥有者却以为任务受限；缺少后端、镜像或身份配置时一律明确失败。（见 personal-agent issue 03 实施计划 §1「真实工具不得在检查失败后回退到后台账户执行」与「交付与验证」，原决定第 3 段）
- **把执行账户加入拥有者的组，让它进入工作区** — 不用逐个工作区配 ACL，一步就能让完全访问读写拥有者的仓库。不选，是因为执行账户不属于拥有者或后台的组是身份设计的前提，入组就可能读到拥有者的认证材料；改为按工作区配 ACL。同一轮也否掉了提交时预检工作区权限，因为后台无法替另一个 uid 判断权限。（见 [personal-agent issue 23](../../../../.scratch/personal-agent/issues/23-container-full-access.md)「已确认范围」）
- **单次 HTTP 授权时给 Shell 临时联网或注入通用凭据** — 批准后现有脚本和命令行工具（curl 等）无需改写就能直接用。不选，是因为批准一个请求就会给脚本开放整台主机的网络，只限目标域名或端口也保证不了同一服务上没有发生其他写操作；改为由受信执行器发出固定方法、目标、头部和正文的单次请求，暂时表达不了的需求明确返回限制，由拥有者选择合适的工具或显式完全访问。（见 personal-agent issue 03 实施计划 §4）
- **被边界拦下后在更高权限下自动重试整个脚本** — 模型不用再拆出一个具体的审批操作，任务少一次中断。不选，是因为脚本失败前可能已经改了工作区或产生了其他副作用，整段重放会重复这些效果；被阻止的访问向模型返回明确错误，由模型提出新的、具体的审批操作。（见 personal-agent issue 03 实施计划 §4）
- **容器把工作区挂到 `/workspace`，在系统提示或路由层翻译路径** — 容器内的布局固定，不依赖宿主路径。不选：系统提示改报 `/workspace` 会让提示随访问模式变化、缓存失效，历史里的路径前后不一致，授予路径仍然看不见；在路由层翻译又翻译不了 bash 命令里的路径。改为按宿主原路径挂载。（见 [personal-agent issue 28](../../../../.scratch/personal-agent/issues/28-container-same-path-mount.md)「已确认范围」）
- **用 Landlock、bubblewrap、systemd 沙箱、Gondolin micro-VM、OpenShell 或 Docker Sandboxes 等机制代替容器** — 不依赖容器运行时，更贴近宿主。2026-09-19 不选，是因为这些机制都没验证过，容器方案已经满足已知要求；当时定下的规则是先不做多后端抽象，目标服务器不支持容器时再评估。Coding Agent 的 Seatbelt/bubblewrap 接入与保留的验证范围由[原生决定](2026-10-10-native-execution-sandbox.md)接管，个人 Agent 的容器选择仍成立。（见阶段 0 基础验证结论「未验证项」第 3 条与「选定方案」）
- **macOS 受限执行改用内置 `sandbox-exec`，不依赖 Docker Desktop** — 系统自带，不需要容器运行时，能直接使用宿主工具链。2026-10-02 不选，依据是文件规则看似静默失效；这条依据已更正为路径别名导致的探针错误。该否决依据不再用于原生选择；非特权后代核实的窄残留与占用保留由[原生决定](2026-10-10-native-execution-sandbox.md)接管。（见 agent-direction issue 03 判定结论第 2 条及 2026-10-08 更正，agent-direction issue 26）

## 后果

- **收益**：路径解析与自由 Shell 全部落在执行边界内，受限任务够不着后台的模型凭据、数据库和控制面。容器按任务建立，后续任务不会继承前一个任务的挂载、环境、残留进程或一次性批准。完全访问任务拿不到控制面身份，不能冒充拥有者。批准只能消费一次，执行参数在批准后不能更换。执行环境缺失时明确失败，拥有者不会误以为任务受限。
- **代价**：要维护一条有界的进程间消息协议，正文捕获也要放在工作进程侧完成。宿主工具只能顺序执行，同一轮的工具调用不能并行。选择 container 的受限任务要启动并回收容器，依赖容器运行时与可信构建的 `ruukoto-worker` 镜像，macOS container 还依赖 Docker Desktop VM。部署要维护三个系统身份、受保护的提权入口和按工作区配置的 ACL。完全访问不提供执行账户内部的文件隔离，该账户可读的文件都可能被任务读取。
- **已知上限**：macOS 完全访问的执行账户入口尚未部署和验证。停止结论的缓存与传播不替代后端的真实回收核实；native 的已知残留和验证范围归原生决定。`local` 后端没有隔离。Docker Desktop 的挂载权限与 inode 语义和原生 Linux 不同，macOS 上的目录身份复核只按路径进行。
- **何时重访**：Coding Agent 的 native 后端已由[原生执行沙箱](2026-10-10-native-execution-sandbox.md)部分接管，其正式入口默认 native 并拒绝旧覆盖；目标个人服务器不支持容器时，重新评估其 Linux 隔离机制。

## 验证

- `test/07-real-tools.test.ts`：真实工具完成「读取—修改—检查失败—修复—检查通过」，正文捕获为产物；断开客户端后任务继续；工作进程启动窗口内的中断同样回收执行单元；执行入口不可用时明确失败，不回退到后台账户执行。
- `test/08-approvals.test.ts`：越界文件读写与单次 HTTP 请求批准后只执行一次；符号链接、等待期间目标被替换、内容变化与保护目录都失败；重定向不自动跟随，凭据不转发到其他地址；重复消费、权限版本变化、任务结束后的消费都被拒绝；DNS 在批准时固定。
- `test/10-access-modes.test.ts`：容器后端下完全访问只有两个包装脚本变量都设置时才得到 `systemd` 启动器，只设一个时以 `execution_unavailable` 失败。`test/73-desktop-execution.test.ts`：Coding Agent 默认 native 并拒绝旧配置，完全访问缺执行账户入口时在执行前拒绝；容器/systemd 的共享启动与停止仍按库层配置核实。
- 真实容器边界：`verification/foundation` 的 `npm run linux:probes`（报告 `results/linux-isolation-report.md` 与 `-tx.md`）和 `verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`，覆盖网络拒绝、宿主路径不可见、非 root、只读根、capabilities 清零、按宿主原路径挂载，以及逃逸孙进程在停止后心跳冻结、容器被移除。这些只能在真实容器引擎上证明，模型打桩或 local 测试替代不了。
- 完全访问身份：tx 实测见 personal-agent issue 23 的 Comments，任务以 `ruukoto-exec` 运行，读取拥有者令牌返回 `Permission denied`。

## 适用范围

当前执行接线由[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)与[原生执行沙箱](2026-10-10-native-execution-sandbox.md)持有：两个产品正式受限入口默认且只接受 native；Docker worker、镜像配置与 container 类型已退役。完全访问采用[当前账户决定](../feature/2026-10-12-full-access-current-account.md)。本篇原容器参数、VM 例外、容器生命周期与专用账户叙述保留为被部分取代的原决定；完整 worker、协议、批准消费与停止核实原则仍适用。当前接口回归由 `test/10-access-modes.test.ts`、`test/73-desktop-execution.test.ts`、`test/100-worker-stop.test.ts` 与 `test/101-native-linux-scope.test.ts` 覆盖；本篇验证节保存原时点的记录，旧容器命令不作为当前活跃入口。

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。

相关方案：[受控文件检索](../../implemented/feature/2026-10-21-controlled-file-search.md)补worker工具清单；[跨轮后台执行](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)另定独立执行归属。本篇原决定及当前受限执行的后续接管关系保留。
