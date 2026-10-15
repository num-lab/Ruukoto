# Personal 目标：SSH 转发与令牌读取

Status: ready-for-human

## 目标与边界

实现[规格 R15 与 R20 中的远程使用说明](../spec.md)：主进程经 SSH 转发连接服务器上的 ruukoto，连接状态与 Code 目标并存。界面在 09。

只支持同账户部署，也就是 SSH 登录账户就是后台账户，即[当前部署步骤](../../../deploy/systemd/README.md)的做法。令牌直接读远端控制目录里的 `owner.token`，不使用副本，所以令牌轮换后，下一次建连自动读到新值。后台账户与登录账户不同的旧式部署（tx 目前就是这种）不在支持范围内。这类部署下登录账户通常读不到原令牌，预检会报终止错误，并提示改为同账户部署。预检只核实目录、socket 与令牌是否可访问，不保证能识别出所有不同账户的部署；文档和错误提示都按这个边界措辞。拥有者完成迁移之前，Personal 目标的真实验收记为不可验证。方案者与实施者都不修改服务器的账户、权限或令牌。

## 方案

1. **配置与输入校验。** 连接目标配置增加 Personal，保存在应用数据目录，不保存令牌。只有两项配置：ssh 主机别名（沿用 `~/.ssh/config`），以及远端控制目录（默认 `/var/lib/ruukoto/control`）。
   - 主机别名必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$`，因此不会以 `-` 开头被当作 ssh 选项；命令行里，主机前面还会再加一个 `--`。
   - 远端控制目录必须是绝对路径，只允许 `[A-Za-z0-9._/-]` 这些字符。OpenSSH 会把远端命令拼成一个字符串交给远端 shell，`-L` 又以 `:` 分隔参数，所以空格、引号、shell 元字符和 `:` 都不能出现。
   - 路径长度检查的是最终的 `<控制目录>/control.sock` 和本地 socket 的完整路径，上限是 Unix socket 路径的长度上限：macOS 103 字节，Linux 107 字节。
   - 不合格的输入在保存配置时就被拒绝。
2. **SSH 进程的生命周期选项。** 两条 ssh 命令都显式加上 `-o BatchMode=yes -o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o ForkAfterAuthentication=no -o RemoteCommand=none -o ConnectTimeout=10`。这样，桌面端启动的 ssh 子进程就是实际持有连接和监听的那个进程：不复用、也不留下 master，不会认证后转入后台。主机名、密钥、ProxyJump 等连接设置仍然沿用用户的 ssh_config。
   - 读令牌的命令另加 `-o ClearAllForwardings=yes -o RequestTTY=no`。
   - 转发命令无法清除 ssh_config 里给这个主机配置的端口转发，因为清除会连带去掉自己的 `-L`。这些转发如果绑定失败（例如本地端口被占用），会触发 `ExitOnForwardFailure`。读取命令清除了转发，看不到这类失败，所以它们由第 7 步的转发退出分类判定为终止失败。文档建议为桌面端单独设一个不带端口转发的主机别名。
   - 桌面端只管理自己启动的进程，不结束用户已有的 master。
3. **远端预检与令牌读取。** 每次控制面建连前，执行一次 `ssh … -- <host> <远端命令>`。远端命令里的路径按 shell 单引号规则转义，复用 03 恢复指引的转义函数，作为第 1 步字符白名单的兜底。远端命令按以下顺序检查，每一项失败时以对应的码退出：
   - 10：控制目录不存在；
   - 11：控制目录不可进入（`test -x`）；
   - 12：`control.sock` 不存在；
   - 13：socket 不可写；
   - 14：`owner.token` 不是可读的普通文件。这里用 `test -f` 和 `test -r`，可以避开 FIFO 这类会让读取一直阻塞的文件。

   以上都通过后，执行 `cat -- <令牌>`。远端登录 shell 需要支持 POSIX 的 `test`、`||` 与 `;`，bash 和 zsh 都满足。
4. **读令牌操作的期限与取消。** 整个预检加读令牌的操作有 15 秒总期限，从 ssh 进程启动开始计时。`ConnectTimeout` 只覆盖 SSH 建连和初始握手，不能代替这个总期限。
   - 超时、目标关闭、改配置或进入终止失败时，监督者先向读取进程发 SIGTERM，2 秒后仍未退出就发 SIGKILL，并等到它确实退出。
   - 每个目标同时最多只有一个读取进程。
   - 超时归为可重试的 `ssh_timeout`。
5. **读取命令的失败分类。** 本节只适用于第 3 步那条短命的预检与读令牌命令，长驻转发进程的退出见第 7 步。是否重试只看退出码和归类后的 `code`，内部各层不解析 message。
   - 0：读到令牌，只放在主进程内存里。
   - 12：远端后台没有运行，可以重试。
   - 10、11、13、14 与 cat 失败：都是终止失败，直接显示修复指引（核对控制目录配置、登录账户是否等于后台账户），不进入退避。
   - 255：ssh 层失败。在 `LC_ALL=C` 下读取 stderr，只有命中网络类文本才算可重试，按退避重连。网络类文本包括：
     - 建连失败：`Connection timed out`、`Connection refused`、`Network is unreachable`、`No route to host`、`Could not resolve hostname`；
     - 连接建立后中断：`Connection closed by`（同时覆盖 `Connection to <host> closed by remote host.`）、`Connection reset`、`Broken pipe`；
     - 用户 ssh_config 若开启保活，保活超时：`Timeout, server` 后接 `not responding`。

     认证失败、主机密钥校验失败、`Bad configuration option`，以及其他未命中上述文本的 255，都归为终止失败：显示 stderr 摘要，等拥有者处理后点“重新连接”。
   - 第 4 步的总期限到时：归为可重试的 `ssh_timeout`。
   - stderr 归类只在 ssh 这个外部程序的边界上进行，归类后转成带 `code` 的错误。
6. **令牌按每次建连获取，共享连接管理器补上取消。** 改动在 `packages/control/src/connection.ts`：
   - `ConnectionConfig.token` 接受固定字符串或异步提供函数，`connectAndSync` 每次建连都重新获取。现有调用方传字符串，行为不变。
   - 提供函数抛出 `outcome` 为 `rejected` 的错误时，进入 `failed`；其他错误走现有的退避重连。
   - 后台换令牌重启后，经转发的连接会断开，重连时取到的就是新令牌；用新令牌仍然得到 `unauthorized` 才算终止失败。
   - `connectAndSync` 的每个异步阶段（取令牌、factory、认证、同步）结束后，都检查连接是否已关闭或换代。如果是，就关闭迟到的 transport、丢弃结果，不发布快照，也不改变状态，避免出现 `closed → online`。同步阶段的检查放在 `sync` 内部：`handshake` 返回之后、调用 `onSnapshot` 和应用补发事件之前。只在外层 `await sync(...)` 之后检查就太晚了。
7. **两层重连的归属。** 每个 Personal 目标由主进程里的一个监督者管理。它持有本目标唯一的转发子进程、读取子进程、本地 socket 路径与 `ControlConnection`：
   - 转发：启动规格 R15 的 `ssh -N … -L <本地>:<远端> -- <host>`，带上第 2 步的选项，本地 socket 放在权限 0700 的目录里。远端 socket 不存在时，转发本身照样能监听，所以 ssh 进程存活、本地 socket 出现，都不能当作远端已就绪；是否在线只看 `ControlConnection` 进入 `online`，也就是认证完成、装好快照。
   - 转发进程退出：监督者为转发进程保留一段有界的 stderr 尾部，按下面的规则处理不是自己主动结束的退出。
     - **转发专属的终止失败**：退出码为 255，并且在 `LC_ALL=C` 下 stderr 命中转发建立失败的文本：`Could not request local forwarding`、`cannot listen to port`、`Bad local forwarding specification`、`Bad stream local forwarding specification`。这类失败只有转发进程能看到，读取预检看不到。监督者把目标置为失败，错误码为 `forward_setup_failed`；关闭 `ControlConnection`，不再重启；错误里显示 stderr 摘要，并提示修复 ssh_config 中这个主机的 `LocalForward`，或者为桌面端单独设一个主机别名。之后只有拥有者点“重新连接”，才重新开始。
     - **其余退出一律退避重启**：退避与 `ControlConnection` 相同，从 500 ms 起，上限 8 s。包括 255（保活超时 `Timeout, server <host> not responding.`、已连接后的 EOF `Connection to <host> closed by remote host.`、`client_loop: send disconnect: Broken pipe` 等）、退出码 0，以及被外部信号结束。
     - **认证、主机密钥和配置这类失败**，读取预检和转发都会遇到，统一由第 5 步判定：每次控制面重连之前都会运行一次预检，预检就是一个新起的 ssh，会按第 5 步给出终止分类；随后 `ControlConnection` 进入 `failed`，监督者停止重启。
     - 监督者自己结束的转发（关闭、改配置、`failed`）一律不重启，靠代次识别。
     - 控制面层的重连由 `ControlConnection` 负责。
   - 终止：`ControlConnection` 进入 `failed`（协议不一致、`unauthorized`、产品不符、第 5 步的终止分类）后，监督者停掉 ssh；之后 ssh 退出不再触发重启。只有拥有者点“重新连接”，才重新开始。
   - 关闭与改配置：取消所有计时器，关闭 `ControlConnection`，结束读取进程与转发进程并等它们退出，再删除本地 socket。监督者用代次丢弃旧子进程的退出事件和迟到的结果。`StreamLocalBindUnlink=yes` 只负责解绑遗留路径，不能证明旧监听者已经退出，所以必须先回收旧进程，再启动新的。
8. **产品身份。** 握手快照 `ConnectSnapshot` 新增 `product: ProductType`，取自 `Runtime.productType`。`PROTOCOL_VERSION` 从 25 升到 26，同步 `protocol.ts` 的版本说明。快照的生产者与构造方要一并同步：`packages/tui/src/tui/demo-session.ts`、`test/helpers/fake-control.ts`，以及直接构造快照的用例；TUI 与 CLI 不读这个字段。桌面端两个目标都核对它，不符时以 `product_mismatch` 进入 `failed`，错误可见，不自动重试，也不进入可操作状态。
9. **文档。** 修订 `docs/modules/tui.md` 与 `docs/usage.md` 的远程使用说明；`docs/modules/desktop.md` 补充 Personal 目标、同账户部署前提、ssh 选项与错误分类；`docs/modules/control.md` 补充快照的 `product` 字段、令牌提供函数与关闭语义。

## 进展与交接

- 当前：Personal SSH 连接、按次令牌、取消与回收、双目标主进程接线、产品身份 v26、测试和文档已实现。独立实现复审通过，无未解决阻断；详见[实现与验收证据](../evidence/08-implementation.md)。
- 下一步：拥有者准备同账户服务器后执行本单外部检查；09 按已确认边界继续 Personal 界面。协议 v26 需要后台与桌面同步更新。
- 基点：本轮实施基于 `dba2109`；03 的依赖实现已具备。本轮实现随当前提交保存。
- 阻塞：仅真实同账户服务器验收缺前提；tx 迁移之前不可验证。未修改服务器账户、权限或令牌。

## 验收与证据

工程定向检查与独立实现审查通过；真实服务器外部验收待完成。完整命令、证据边界和审查返工见[实现与验收证据](../evidence/08-implementation.md)。

- **输入校验与命令构造**（`test/38-desktop-personal.test.ts`；既有主进程回归仍在 `test/38-desktop-main.test.ts`）：
  - 主机别名为 `-oProxyCommand=x`、空串或含空格时，都被拒绝；远端路径含空格、单引号、`;`、`$(`、反引号、`:`、换行，或是相对路径、最终 socket 路径超长时，也都被拒绝。
  - 合法路径生成的远端命令经本机 `/bin/sh -c` 执行，能读到临时令牌；标记文件证明没有执行额外命令。
  - 两条 ssh 命令都在主机前带 `--`；本地 socket 所在目录的权限是 0700。
- **生命周期选项**：准备一份临时 ssh_config，开启 `ControlMaster auto`、`ControlPersist`、`ForkAfterAuthentication`、`RemoteCommand` 与 `RequestTTY`。对两条命令分别跑 `ssh -F <临时配置> -G`，断言第 2 步列出的选项全部以显式值生效。
- **预检分类**（本机 `/bin/sh` 执行远端命令，使用临时目录）：
  - 控制目录不存在得到 10，不可进入得到 11。不可进入时目录里确实已有 socket，借此证明不会误报为 12。
  - socket 不存在得到 12，不可写得到 13。
  - 令牌是 FIFO 时得到 14，并且立即返回，不阻塞。
- **读取命令的失败分类**：用替身 ssh 可执行文件返回预设的退出码与 stderr，断言每种情况得到的 `code` 和是否重试。stderr 直接用 OpenSSH_10.3p1 的实测输出：
  - `Timeout, server <host> not responding.`、`Connection to <host> closed by remote host.`、`client_loop: send disconnect: Broken pipe`，以及建连失败类文本：都可重试；
  - 认证失败、主机密钥失败、`Bad configuration option`、未知 255：都是终止失败；
  - 超过总期限：`ssh_timeout`。
- **转发进程退出**（替身 ssh 加真实 `ControlConnection`）：
  - 已经 `online` 之后，替身转发以 255 退出，stderr 用保活超时文本；再测一次 EOF 文本；完整走一遍“退避重启转发 → 预检重新取令牌 → 同步快照 → `online`”。
  - 未经监督者主动结束的退出码 0、被外部信号结束：同样会重启。
  - 监督者因关闭、改配置或 `failed` 主动结束转发：不会重启。
  - 转发反复退出，同时预检返回认证失败：进入 `failed`，并停止重启。
  - 读取预检一直成功，转发却以 255 退出，stderr 是本轮实测的绑定冲突输出（`Address already in use`、`cannot listen to port`、`Could not request local forwarding.`）：断言目标进入失败、错误码为 `forward_setup_failed`、不再重启转发，错误中带有修复转发配置的提示。保活超时、EOF 与外部结束的恢复用例仍然保留。
- **期限与取消**：用替身 ssh 让读取一直阻塞，断言 15 秒期限到时进程被结束并回收。读取期间关闭目标，读取进程同样被回收。两种情况都没有遗留进程。
- **共享连接管理器**（真实 `ControlConnection` 加延迟替身）：
  - `close()` 之后，迟到的 factory 结果和令牌结果都被丢弃，迟到的 transport 被关闭，不发布快照，状态也不会进入 `online`。在 `handshake` 等待期间关闭，同样不调用 `onSnapshot`，也不应用补发事件。
  - 转发仍在时后台换令牌重启，第二次认证用的是新令牌，并最终 `online`。
  - 远端 socket 暂时不可用（预检返回 12），恢复后自动 `online`；可重试的网络类故障恢复后也自动 `online`。
  - 用新令牌仍得到 `unauthorized` 时进入 `failed`；协议不一致进入 `failed` 后，ssh 退出不再触发重启。
  - 传字符串令牌的现有调用方保留回归：`test/12-reconnect-pending.test.ts`、`test/19-tui-demo.test.ts`、`test/66-control-seam.test.ts` 都不回归。
- **产品身份**：快照的 `product` 来自 `Runtime.productType`；桌面端误连 ruukoto-code（替身快照为 `product: "ruukoto-code"`）时，以 `product_mismatch` 进入 `failed`，不重试。升到 v26 后，demo 与 fake-control 已同步，`test/12-reconnect-pending.test.ts` 与 `test/72-on-demand-backend.test.ts` 中与版本相关的用例不回归。

人工检查（外部验收，需要一台按同账户部署的服务器）：

- 连上后看到快照；应用数据目录里没有令牌。
- 杀掉 ssh 进程后，连接自动恢复。
- 删除远端 `owner.token` 并重启后台服务，后台随即启用新令牌；转发不断的情况下，桌面端以新令牌恢复连接。
- 关闭目标或退出应用后，本地 socket 不再接受连接，`pgrep` 找不到桌面端启动的 ssh 进程；用户已有的 ssh master 不受影响。
- 主机需要密码、登录账户不是后台账户，这两种情况都显示明确的错误，并且不进入重试循环。

缺少同账户部署的服务器时，以上记为不可验证。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

### 2026-10-15 首轮独立方案审查

对象：当前检出 `43c16ac`，本单审查前 SHA-256 为 `5ca93bcd4d2da2acb818492e75e2131c9974224baa772beb6d27832aed7a2e27`；核对工作区现行规格 R3／R5／R6／R15／R19／R20、桌面客户端提案、02／03 依赖方案及控制面源码。结论：需要修订，以下四项交方案者处理。审查没有修改实现、服务器部署或其他工单。

1. **P1：第 2 步没有处理远端 shell 对控制目录的解释。** 本地用 `spawn("ssh", argv)` 并不能保留远端参数边界：OpenSSH 会把 host 后的命令与参数以空格拼接，再交给远端 shell。带空格的目录会拆成多个路径，带分号或命令替换的目录可执行额外命令。真实 `ssh tx` 隔离探针把 `/does-not-exist-r08; printf RUUKOTO_REVIEW_SHELL_MARKER #/owner.token` 作为一个 argv 传给 `cat`，仍输出标记并返回 0；对完整路径做 shell 单引号转义后，标记不再执行，`cat` 返回 1。修订要求：定义主机别名与远端绝对路径的输入校验，host 不得被解释成 ssh 选项；远端 `cat -- <路径>` 对完整路径作 shell 转义，`-L` 则按它自身的参数语法构造，不能套用同一层转义。测试覆盖空格、单引号、shell 元字符和非法别名，并实际经过 shell 验证路径原样传递、额外命令没有执行。依据：[ssh(1) 的远端命令参数规则](https://man.openbsd.org/ssh.1#DESCRIPTION)与仓库输入边界要求。

2. **P1：第 3 步仅在 ssh 重启时重读令牌，不能实现 R15 的每次建连跟随令牌更新，也没有闭合两层重连。** [ControlConnection](../../../packages/control/src/connection.ts)的 `ConnectionConfig.token` 是固定字符串，每次 `connectAndSync` 都复用它；明确的 `unauthorized` 会进入 `failed` 并停止重试。服务器以新令牌重启但 SSH 隧道仍在时，控制面会自动重连并使用旧令牌，无法恢复；本轮使用真实 `ControlConnection` 加替身 transport 已复现两次认证都收到旧令牌，最后状态为 `failed`。此外，远端 socket 不存在时，本地转发仍能监听，`ExitOnForwardFailure=yes` 不会使 ssh 退出，不能把 ssh 存活或本地 socket 出现当作远端就绪。修订要求：明确每次控制面连接如何取得新令牌、SSH 与控制面各由谁安排重试，在线须以认证和快照完成为准；协议不兼容等终止失败不能被 SSH 退出回调重新启动，关闭或改配置时取消旧尝试并收回本目标的子进程。补测 SSH 存活时后台换令牌重启、远端 socket 暂不可用后恢复、协议失败后 SSH 退出仍不自动重连，以及关闭期间迟到的连接结果；同时明确 SSH 认证失败、网络失败和读令牌失败的分类与停止条件。依据：[ssh_config(5) 的 ExitOnForwardFailure](https://man.openbsd.org/ssh_config.5#ExitOnForwardFailure)、R5／R15 与 [error-handling](../../../.agents/skills/error-handling/SKILL.md) 的重试归属要求。令牌在 [ControlServer.start](../../../packages/control/src/server.ts) 中读取一次；轮换验收须覆盖后台实际启用新令牌，不能只替换文件。

3. **P1：默认控制目录在现有服务器上可连接，但原始令牌对登录账户不可读。** 本轮只用 `ssh tx` 的 `stat` 与 `os.access` 核实，未读取令牌内容：登录 UID 为 1003；`/var/lib/ruukoto/control` 为 0770，登录账户非属主但可以遍历；`control.sock` 为 0660、可写；`owner.token` 为 0600、非登录账户所有且不可读。因此“socket 可达”不足以证明第 2 步可用，默认读令牌命令会在建隧道前失败。[当前部署步骤](../../../deploy/systemd/README.md)采用后台与 CLI 同账户、目录 0700，适用于这种部署；[现有客户端](../../../packages/control/src/connect.ts)也另有不同 UID 时的 `RUUKOTO_OWNER_TOKEN_FILE` 来源，但本单只读固定 `owner.token`，没有沿用该来源。修订要求：写清支持的 SSH 登录账户与文件权限前提，给出实际验收目标的可行接入方式；若维持两个配置项，应先核实指定别名确实能以所需账户读取原令牌并连接 socket。权限不足应给出可操作的错误，不进入网络退避循环；不得以放宽令牌到所有人可读解决。该项是待闭合的部署前提，当前没有修改服务器账户、权限或令牌来源。

4. **P2：第 2 步假定连接已有 `product_mismatch`，但当前接口没有这一检查。** `ControlConnection` 没有 expected product 参数，`ControlClient.authenticate` 只传 token，`handshake` 只传 since，[ConnectSnapshot](../../../packages/control/src/protocol.ts)也不含产品身份。现有 [Runtime 的 product_mismatch](../../../packages/runtime/src/runtime.ts)只拒绝以错误产品启动已有数据目录，不会在客户端误连另一产品时触发；02 的显式产品改动只作用于本地路径解析，03 也没有补这条连接契约。控制目录误填为同账户 ruukoto-code 的目录时，读取对应令牌后可以正常握手，本单无法按计划拒绝。修订要求：明确产品身份从哪里取得、在哪一层校验及由哪张工单实现；涉及协议时列出字段、版本与调用方同步范围。加一条误连 ruukoto-code 的定向检查，证明 Personal 不进入可操作状态，错误可见且不自动重试。

已核实的原交接事项：`StreamLocalBindUnlink=yes` 在本机 0700 临时目录内能替换关闭后遗留的 socket 并建立新监听。它只负责解绑路径，不证明旧监听者已经退出，实施仍须串行管理自己拥有的转发进程与 socket 路径。远端 socket 不存在的隔离转发探针确认：本地连接随后关闭，ssh 仍存活并输出 channel open failed；结束时只终止并回收探针启动的 ssh，临时目录已清理，未连接生产控制面。

本轮证据：macOS arm64、Node v24.15.0、OpenSSH_10.3p1；真实 SSH 权限、远端 shell 参数与残留 socket／远端缺失 socket 探针全部执行，令牌轮换场景使用真实连接管理器与替身 transport。`npx tsx --test --test-name-pattern='断线后重连|认证失败与协议不兼容|认证超时与认证中途断线|首次连接' test/12-reconnect-pending.test.ts` 实际选中认证拒绝与认证中断两项，2/2 通过；不声称该表达式覆盖了断线补发或首次建连用例。

未覆盖：桌面实现尚不存在，未运行 Electron、完整 GUI、真实令牌轮换或生产快照验收；未运行全量检查。实际服务器权限差异与上述方案缺口解决前，不交实施。

### 2026-10-15 方案修订

方案者按首轮审查修订，拥有者确认的目标不变。

- **P1 远端转义**：第 1 步为主机别名和远端路径设字符白名单，并在主机前加 `--`；第 2 步在白名单之外再做单引号转义作兜底。验收包括非法输入被拒绝，以及在真实 `/bin/sh` 下检查路径能原样传递。路径白名单排除了 `:`，`-L` 的 `:` 分隔语法因此不需要另做转义。
- **P1 令牌与两层重连**：第 3 步让 `ControlConnection` 每次建连都重新取令牌；第 4 步规定 ssh 由监督者重启，控制面由 `ControlConnection` 重连，以 `online` 判定就绪；`failed` 之后不再重启 ssh；关闭时回收子进程，并用代次丢弃迟到的结果。
- **P1 账户权限**：“目标与边界”写明支持的两种部署，第 1 步增加可选的令牌文件配置；第 2 步的远端预检按退出码区分 socket 缺失、socket 不可写、令牌不可读三种情况，后两种是终止失败，不进入网络退避。tx 需要由拥有者放一份令牌副本，方案者不改服务器。
- **P2 产品身份**：第 5 步在快照里加入 `product`，协议升到 v26，桌面端两个目标都核对。
- 规格 R15 已同步：增加可选的令牌文件与两种部署前提。

方案者已在当前代码上核实：`ConnectSnapshot` 没有产品字段（`protocol.ts`）；`ConnectionConfig.token` 是固定字符串，`connectAndSync` 每次建连都复用它（`connection.ts` 第 37、94 行）；`Runtime.productType` 可以作为快照的来源（`runtime.ts` 第 378 行）；现行协议为 v25，已有 v24、v25 的说明（`protocol.ts`）。

### 2026-10-15 第二轮独立方案审查

对象：`43c16ac` 上的工作区修订，本单复审前 SHA-256 为 `cc65c34f01e1740607b9e2871431122fc34bf3716b104a00b5c5ef78d9f84287`，规格为 `cd7f213c7a17268178012f031325907567f6f4484baa1cd3d123fc42fbc4171a`；核对现行 R15、提案笔记、共享连接管理器与快照调用方。实现源码未变，首轮未受影响的证据继续有效。结论：仍需修订，以下四项交方案者；本轮只更新本单审查与交接。

已解除的首轮意见：第 1、2 步通过输入白名单、主机参数终止符与远端路径转义覆盖原命令注入反例；第 5 步已明确产品身份来源、协议升版、桌面两目标校验及误连验收，解除“等待一个不存在的 product_mismatch”问题。按次取令牌、以认证和快照判定在线、明确失败停止监督者的方向成立，不重复要求重做这些部分。

1. **P1：令牌副本不会随原令牌更新，当前轮换验收在不同账户部署下必然失败。** “目标与边界”让 tx 读取一个独立的 0400 副本，而人工验收只删除原 `owner.token` 并重启后台。无论提供函数调用多少次，它都只能读到旧副本；第 3 步又规定 `unauthorized` 直接终止，后续即使补更新副本，也不会自动恢复。本轮在隔离目录调用真实 `ensureOwnerToken`／`tokenMatches`，按“复制 → 删除原文件 → 重新生成 → 重读副本”复现：原令牌已更新，副本仍旧，认证比较失败。修订要求：定义两种部署各自的完整轮换步骤、同步责任与恢复时序，补上副本更新滞后和先收到 `unauthorized` 的验收；R15 的“远端令牌更换后，下次建连可用”须与实际可实现的行为一致。若选择依赖人工更新副本并重新连接，应明确这是不同账户部署的限制，不能仍把当前步骤记为自动恢复验收。无需为复审操作 tx 的生产令牌。

2. **P1：沿用 ssh_config 的连接复用与后台化设置，会破坏第 4 步的进程归属保证。** `ControlMaster auto`／`ControlPersist` 可让取令牌命令留下后台 master，随后转发由它持有，桌面监督者记录的 `ssh -N` 子进程不是实际监听者。本轮使用独立 ControlPath 对 `tx` 做隔离探针：先运行无副作用的 `true` 建立 master，再转发到不存在的远端 socket；终止并等待转发子进程退出后，本地 socket 仍可连接。因而“旧子进程已退出 → 删除 socket → 启动新进程”不能证明旧转发已停止，应用关闭或改配置会留下转发；继承 `ForkAfterAuthentication` 同样会让持有的 PID 与后台进程分离。修订要求：两条 ssh 命令显式约束进程生命周期，最小方案是禁用连接复用、ControlPersist 与认证后后台化，同时保留主机、密钥、代理跳板等连接设置。单测用开启这些选项的临时配置经 `ssh -G` 核对实际生效值，真实 SSH 验收覆盖退出后旧 socket 不再接受连接；不能通过结束用户已有 master 清理。依据：[OpenSSH 的 ControlMaster／ControlPath／ControlPersist](https://man.openbsd.org/ssh_config.5#ControlMaster)。

3. **P2：取令牌的短命 SSH 操作没有完整的超时、取消与资源回收契约。** 第 4 步只明确持有转发子进程，而第 2 步每次另起一个 ssh；代次检查只丢弃结果，不能终止仍在运行的读取。第 1 步允许的绝对路径也可能指向 FIFO，本轮在隔离目录执行方案的 `test -S; test -w; cat` 序列，合法 FIFO 路径使读取持续等待，只能由探针主动终止；网络握手或远端启动脚本阻塞也发生在控制面认证超时之前。现有 `ControlConnection.close()` 本身也不会回收迟到的 factory 结果：真实类加延迟替身的探针出现 `closed → online`，并留下一条未关闭 transport 和一次迟到快照。修订要求：为整个预检／读令牌操作定义有限期限与取消归属，关闭、改配置和终止失败时回收读取进程及转发进程；把取消检查落实到共享连接管理器的异步阶段，迟到 transport 必须关闭，不只是屏蔽 UI 回调。补测阻塞读取超时、读取期间关闭、迟到 factory／令牌结果，断言无遗留进程或 transport、无快照发布且不再进入 online。`ConnectTimeout` 只覆盖 SSH 建连与初始握手，不能代替远端读命令的总期限，见 [OpenSSH 说明](https://man.openbsd.org/ssh_config.5#ConnectTimeout)。

4. **P2：失败分类仍把必须修复的权限或配置错误变成无限重试。** 两个隔离反例均已执行：已存在的 socket 位于不可遍历的控制目录时，`test -S` 返回假，方案直接以 3 退出，后面的可写检查根本不会执行；带未知配置项的 ssh_config 让真实 OpenSSH 返回 255、stderr 为 `Bad configuration option`，不匹配列出的三种认证文本，因此被归为网络故障。前者违反“权限不足终止”的修订承诺，后者无法靠退避恢复。[ssh(1)](https://man.openbsd.org/ssh.1#EXIT_STATUS)只保证错误使用 255，并不把它定义为网络错误。修订要求：在声称 socket 缺失前区分控制目录访问失败与确实缺失；对本地配置错误、未知 SSH 失败给出保守且有界的处理，不能把未匹配文本默认当作可持续重试的网络故障。补测不可遍历目录、SSH 配置错误和未知 255；保留真实瞬时网络故障的恢复用例。

实施交接提醒（不另计阻断）：快照字段除了服务端生产者，还要同步 [TUI demo](../../../packages/tui/src/tui/demo-session.ts)、[fake-control](../../../test/helpers/fake-control.ts)和直接构造快照的用例；共享 `ControlConnection` 的字符串令牌调用方保留回归，重点是 test/12、19、66。路径字节上限检查应针对最终 `<控制目录>/control.sock` 与本地完整 socket 路径，普通令牌文件不受 Unix socket 路径长度限制。

本轮证据：macOS arm64／Node v24.15.0／OpenSSH_10.3p1。隔离令牌副本轮换、迟到 transport、目录权限预检、FIFO 阻塞与 SSH 配置错误探针全部断言通过，分别证明上述反例；未输出令牌值。另用 `ssh -G` 确认显式的 `ControlMaster=no`、`ControlPersist=no`、`ControlPath=none`、`ForkAfterAuthentication=no` 能覆盖临时配置中的相反值。真实 SSH 复用探针只运行 `true` 并转发到不存在的远端路径，独立 master 最后收到 `-O exit`（退出码 0），本地临时目录已清理；未读取生产令牌、连接生产控制面或修改服务器部署。

未覆盖：未运行 Electron、真实后台令牌轮换及完整 GUI 验收；源码未变，没有重复执行首轮认证用例或全量检查。上述结果是方案反例与现有行为证据，不是本单实现通过证明。

### 2026-10-15 第二轮方案修订

方案者按第二轮审查修订。

- **P1 令牌副本**：令牌文件这一配置项是首轮修订时方案者自己加的，拥有者确认的 R15 只有两项配置，读取的是 `<控制目录>/owner.token`。现在退回这个范围，只支持同账户部署，也就是当前的官方部署方式。令牌没有副本，轮换后下次建连自动读到新值，副本滞后的问题也就不存在了。后台与登录账户不同的部署由预检以终止错误拒绝。tx 需要由拥有者迁移到同账户部署，迁移之前真实验收记为不可验证。规格 R15 与笔记已同步。
- **P1 连接复用**：第 2 步给两条 ssh 命令显式关闭连接复用、ControlPersist 与认证后转入后台，读令牌的命令还会清除转发；验收中用 `ssh -G` 核对实际生效值。方案者已实测（OpenSSH_10.3p1）：显式选项能覆盖临时配置里相反的 `ControlMaster`、`ControlPersist`、`ForkAfterAuthentication`、`RemoteCommand` 与 `RequestTTY`；配置里的 `LocalForward` 会留在转发命令中，这一限制写进了第 2 步。
- **P2 期限与取消**：第 4 步定义 15 秒总期限，以及读取进程的回收方式；第 6 步让共享连接管理器在每个异步阶段之后检查是否已关闭或换代，并关闭迟到的 transport。
- **P2 失败分类**：第 3 步改为先查控制目录是否存在、能否进入，再查 socket；令牌必须是可读的普通文件，避开 FIFO。第 5 步对 255 只按网络类文本白名单重试，其余一律终止。
- **实施交接**：快照的构造方同步、字符串令牌调用方的回归写进第 8 步与验收；路径长度检查只针对 socket 路径，写进第 1 步。

### 2026-10-15 第三轮独立方案审查

对象：`43c16ac` 上的工作区修订，本单复审前 SHA-256 为 `814a14254d71c3be9baecbb8b879b3e0e9f73f4a2f3685f74519cfa229c3d422`，规格为 `f35d321072ffe4423dcd5ba10738710325996c21ec645742f7d5a9660a69179c`；核对第 2–7 步、R15、提案笔记和现有连接管理器。源码未变，沿用前两轮仍适用的证据。结论：仍有下述 1 项 P1，交方案者修订。

已解除：撤销未确认的令牌副本配置，回到直接读取原令牌与当前部署文档的同账户前提，副本滞后反例不再适用；两条命令已显式禁止连接复用和后台化；读取进程有总期限与升级终止，监督者持有读取和转发两个进程；共享连接管理器要求每个异步阶段检查关闭／代次并回收迟到 transport。新版预检经本机 `/bin/sh` 执行，目录缺失、socket 缺失、目录不可进入、socket 不可写、FIFO 令牌与正常文件分别得到预期的 10、12、11、13、14、0；读取命令经真实 `ssh -G` 验证，生命周期选项、RemoteCommand、RequestTTY 与清除转发均覆盖临时配置的相反值。不同账户部署的真实接入继续是已明示的外部前提缺口，不记为通过。

1. **P1：第 5 步的网络文本白名单遗漏了已建立连接后的断线，第 7 步不能按承诺自动恢复。** 方案显式启用 `ServerAliveInterval=15`，但 OpenSSH 保活失败时输出 `Timeout, server <host> not responding.`，以 255 退出；它不匹配 `Connection timed out` 等任何一条现有文本，因此会被判为终止失败。同样，已连接隧道收到 EOF 时，实际输出为 `Connection to <host> closed by remote host.`，随后可能带 `client_loop: send disconnect: Broken pipe`，退出码也是 255；这也不匹配 `Connection closed by`。本轮分别通过隔离 TCP 中继丢弃本连接流量、关闭本连接中继复现，两次按方案白名单判断均为不可重试。终止后只能手动重新连接，与 R15 和第 7 步的断线恢复要求相反。修订要求：将真实的保活超时、已连接后的 EOF／断开纳入可恢复分支，同时保留认证、主机密钥、配置与未知故障的终止策略；区分读取命令的退出结果与长驻转发进程的退出事件，明确非本目标主动关闭导致的退出码 0／信号退出如何恢复，主动关闭或 failed 仍不得重启。验收应使用本轮实际输出作分类输入，并覆盖“已在线 → 保活超时或 EOF → 退避重启转发 → 重新取令牌并同步快照 → online”；只有伪造 `Connection timed out` 的用例无法证明这些分支。依据：[OpenSSH clientloop.c](https://raw.githubusercontent.com/openssh/openssh-portable/master/clientloop.c)的 `server_alive_check` 与 `client_process_net_input`，以及下述实际探针。

实施提醒（不另计阻断）：第 6 步的“不发布迟到快照”要在 `sync` 内部、`handshake` 返回后且调用 `onSnapshot`／补发事件之前检查；仅在外层 `await sync(...)` 后检查已经太晚。验收除延迟 factory／令牌外，补一条握手等待期间关闭的用例即可落实既定要求。支持同账户部署是运行前提；现有预检核实的是可访问性，不能仅凭可读可写断言任意不同 UID 都必然被拒绝，文档和错误提示应准确表达这一点。

本轮证据：macOS arm64／Node v24.15.0／OpenSSH_10.3p1。两个真实 SSH 探针连接 tx，但只将独立本地 socket 转发到不存在的远端路径；通过本机隔离 TCP 中继模拟断线，未连接生产控制面。保活探针仅把间隔与次数调为 1 加快观察，退出 255，输出 `Timeout, server <host> not responding.`；EOF 探针保留间隔 15，退出 255，输出上述 remote host 与 Broken pipe 文本。另一次对本轮独立转发子进程发送 SIGTERM，观察到退出码 0、stderr 为空，用于提醒退出分类不能只处理 255。所有探针子进程已等待退出，中继已关闭，临时目录已清理；未读取生产令牌或修改服务器配置。

未覆盖：未运行 Electron、真实后台令牌轮换及完整 GUI；同账户服务器外部验收仍缺前提。没有重复执行源码未变的既有测试或全量检查；本轮结果是方案验证，不是实现验收。

### 2026-10-15 第三轮方案修订

方案者按第三轮审查修订。

- **P1 自动恢复**：第 5 步改为只管短命的读取命令，可重试的文本白名单补上了实测到的保活超时、远端关闭与 `Broken pipe`。第 7 步改为不按 stderr 给长驻转发进程分类：凡不是监督者主动结束的退出，都按退避重启，包括 255、退出码 0 和外部信号。需要拥有者处理的失败统一由每次重连前的预检判定，预检判为终止后，连接进入 `failed`，监督者随之停止重启。这样只有一处判定终止，转发退出时不会把断线误判为终止。验收直接用本轮实测的 stderr 作为输入，覆盖“`online` → 保活超时或 EOF → 恢复到 `online`”的完整链路，以及不重启的几种情况。
- **实施提醒**：迟到快照的检查位置（放在 `sync` 内部、`onSnapshot` 之前），以及握手等待期间关闭的用例，已写进第 6 步与验收。不同账户部署的措辞已改为“通常会在预检时报错，但不保证都能识别”。

### 2026-10-15 第四轮独立方案审查

对象：`43c16ac` 上的工作区修订，本单复审前 SHA-256 为 `3be7bcddc34b861919f6f1729243bc44522ef531d9d249c62178966645415059`；规格 SHA-256 仍为 `f35d321072ffe4423dcd5ba10738710325996c21ec645742f7d5a9660a69179c`。复核第 5、7 步及其调用关系、取消检查和验收，源码未变。结论：上轮 P1 已在方案层解除，仍有下述 1 项 P2 交方案者。

已解除：读取命令纳入前轮真实保活／EOF／Broken pipe 输出；转发进程明确覆盖非主动退出的 255、0 与信号，监督者主动关闭仍不重启；验收要求恢复到重新认证并装好快照的 online，而非仅启动新进程。迟到握手的检查位置与回归用例也已补齐，不重复打开这些部分。

1. **P2：不能把转发专属的永久失败全部交给读取预检判定。** 第 2 步保留 ssh_config 中的 `LocalForward`，并说冲突经 `ExitOnForwardFailure` 按第 5 步分类；但修订后的第 5 步只管读取命令，而且读取命令设置了 `ClearAllForwardings=yes`。第 7 步又让所有非主动转发退出无条件重启。因此，配置中的本地端口被占用时，读取 ssh 可以反复成功，转发 ssh 却每次都以绑定错误退出，永远不会出现方案所依赖的“预检终止 → failed → 停止重启”。本轮用同一临时 ssh_config 对真实 OpenSSH 验证：读取侧执行无副作用的 `true` 返回 0；转发侧返回 255，stderr 为 `Address already in use`、`cannot listen to port`、`Could not request local forwarding.`。读取侧清除了转发，所以即使替换成成功的远端权限／令牌检查，也不能观察到这个本地错误；现有控制面连接失败只会继续退避。修订要求：保留已通过的正常断线恢复，为只有转发进程能观察到的绑定／配置失败保留终止分类与可操作的错误，并同步第 2、5、7 步；不必重写整个监督者，也不能仅增加一条“预检也会失败”的假设。补一条“读取侧持续成功，转发因绑定冲突失败”的验收，断言目标进入失败、停止重启并提示修复转发配置；同时保留保活／EOF／外部结束恢复用例。

本轮证据：macOS arm64／OpenSSH_10.3p1。在本机临时目录创建 ssh_config，沿用现有 tx 连接设置，另加指向探针占用端口的 `LocalForward`；读取命令使用方案的清除转发选项，转发命令使用 `ExitOnForwardFailure=yes` 和独立 Unix socket。两条真实命令的退出码及错误文本已断言，均已等待退出，占用端口已释放，临时目录已清理。远端只执行 `true`，转发目标为不存在的路径；未读生产令牌、连接生产控制面或更改服务器部署。

未覆盖：桌面实现尚不存在，未运行 Electron、真实令牌轮换或完整 GUI；同账户服务器验收仍缺前提。前轮未受影响的探针与既有测试证据沿用，不重复执行全量检查。本轮只更新本单审查与交接。

### 2026-10-15 第四轮方案修订

方案者按第四轮审查修订。

- **P2 转发专属失败**：第 7 步给转发进程的退出加了一条终止分类：255，且 stderr 命中转发建立失败的文本（`Could not request local forwarding`、`cannot listen to port`，以及两条转发配置语法错误），归为 `forward_setup_failed`。监督者随即把目标置为失败、停止重启，并提示修复 `LocalForward` 或单独设一个主机别名。其余非主动退出仍一律退避重启，所以保活超时、EOF 与外部结束照样能恢复。第 2 步不再说这类冲突“按第 5 步分类”，改为引用第 7 步。
- **验收**：新增一条“读取侧一直成功、转发因绑定冲突失败”的用例，输入直接用本轮实测的 stderr。
- 第 5 步仍然只管读取命令，不需要改动。

### 2026-10-15 第五轮独立方案审查

对象：`43c16ac` 上的工作区修订，本单复审前 SHA-256 为 `8fd608c390e0fd7f435a7fcd5ca603fefbaabb29e73f4b1658210aaf2028dbbf`，规格 SHA-256 仍为 `f35d321072ffe4423dcd5ba10738710325996c21ec645742f7d5a9660a69179c`。复核第 2、5、7 步、对应验收与依赖交接；实现源码未变。结论：方案审查通过，第四轮 P2 已解除，无新增阻断，转 `ready-for-agent`，仍须等待 03 完成。

第四轮实际绑定冲突输出包含 `cannot listen to port` 与 `Could not request local forwarding`，已落入第 7 步的 `forward_setup_failed`：由监督者直接把目标置为失败、关闭控制面连接并停止重启，不再依赖读取预检也失败。第 2 步对转发冲突的说明已同步，验收明确使用“读取预检持续成功、转发绑定失败”的反例，并断言最终失败状态、错误码、停止重启和修复提示，能够检查原缺口。

同时复核恢复与关闭分支：前轮保活超时、EOF、Broken pipe、退出码 0 与外部信号不会命中上述绑定失败分类，仍按退避恢复；监督者因关闭、改配置或 failed 主动结束的进程不重启。共享连接的迟到握手检查位于快照和补发事件发布之前，验收已覆盖。前几轮已解除的输入边界、令牌来源、进程归属、读取期限、产品身份与调用方同步不重复打开。

本轮只执行方案条款覆盖与本地链接核对，并检查本单差异格式；第四轮真实绑定冲突、第三轮真实断线以及此前权限／进程探针作为未失效证据沿用，没有把正文覆盖检查当作运行时测试。仅修改本单状态、交接与审查记录，保留工作区其他修订。

交接与未验证项：实施者完成本单列出的单测、共享连接与快照构造方回归、文档同步后交独立实现审查；真实 SSH、Electron、令牌轮换与完整 GUI 按人工清单另验。同账户服务器前提尚未满足，不能将方案通过记为工程或产品验收通过。源码未变，本轮未重复执行既有用例或全量检查。


### 2026-10-15 实施与独立实现验收

当前方案在 `dba2109` 上落地，未修改确认范围；Personal 界面仍留在 09。退避审查发现认证／握手期间断线丢失指数间隔、转发恢复后未可靠归零，两项均由原反例和永久回归解除。最终 12／Personal 定向 51/51，其他调用方 156/156，退避修复后相关调用方再验 77/77；静态检查、桌面构建、签名与真实 Electron 隔离探针通过。独立只读复审无未解决阻断。工单状态保留 ready-for-human，恢复条件与未验项见[证据](../evidence/08-implementation.md)；未提交或推送。

2026-10-15：拥有者授权本地提交本单实现与验收证据；ready-for-human 的服务器外部验收缺口保留，不推送或部署。
