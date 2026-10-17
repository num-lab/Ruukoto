# 操作手册

本页是 `ruukoto`（个人 Agent）与 `ruukoto-code`（Coding Agent）的操作入口：运行、配置、启用各入口、导入旧实例与故障排查。机制解释见[架构总览](architecture.md)与[模块文档](modules/)，开发与测试见[开发说明](development.md)。

## 1. 前提与安装

开发与离线检查需要 Node ≥ 22.19、Git、Bash 和支持 PTY 的 Python 3，使用 macOS 或 Linux 的普通用户账户。两个产品的受限执行均使用原生沙箱与宿主工具链，无需 Docker：macOS 构建需 Command Line Tools 的 Clang，Linux 前置见[原生沙箱部署](../deploy/native/README.md)。个人 Agent 面向 Linux 常驻服务，另需运行账户的 user manager 与 linger 配置。

```bash
npm run setup       # 按两份锁文件安装依赖、检查前提并安装轻量提交钩子
npm run build       # 构建工具 worker、macOS 原生监督器与 app 包
npm link            # 可选：把 ruukoto / ruukoto-code 装进 PATH（否则用 npm start -- …）
```

根 `npm start -- …` 默认使用 ruukoto app，保留 `RUUKOTO_PRODUCT=ruukoto-code` 的入口选择；也可用 `npm start --workspace=ruukoto-code -- …`。各 app 的 bin 固定产品身份；构建出的 app tarball 引用同仓共享包，部署保留完整 workspace。生产部署的系统身份、systemd 单元、提权入口与服务 helper 见 [deploy/systemd/README.md](../deploy/systemd/README.md)。

## 2. 运行

### 2.1 启动后台

```bash
# 生产：原生执行后端，先完成 deploy/systemd 配置
# server 为推荐命令，start 是同一实现的兼容别名
npm start -- server --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent \
  --execution native --model provider/model

ruukoto-code server                    # 默认原生受限执行
npm start -- stop                     # 优雅停止（SIGTERM/SIGINT 走同一路径）
```

两个产品均默认 native，正式入口仅接受 native；`--execution` 或 `RUUKOTO_EXECUTION_BACKEND` 中的 local/container 明确拒绝，改为 native 或移除覆盖后再启动。native 在 macOS 使用 Seatbelt 与原生监督器，在 Linux 使用 bubblewrap、namespace/seccomp 与 user scope/cgroup；缺失或失效在执行前以 `execution_unavailable` 拒绝，不回退。升级先停旧后台再重启，不在线替换活动任务的执行环境。库层 local 无隔离，只供完全访问与离线测试，不是正式受限入口。完全访问在两平台直接使用启动后台账户，继承后台实际的 PATH、HOME、代理、SSH agent 与工具凭据；清除内部 Ruukoto 控制变量，不要求执行账户入口。

新档案一次性创建当前 schema；既有档案的版本必须与代码完全一致，旧库与较新库均明确拒绝启动，不自动升级或回填。保留原档案，用匹配版本的代码查阅；需要当前版本时使用独立新档案。跨实例导入也只接受当前格式，不能用它转换旧 schema。

### 2.2 交互入口

两个入口都需要 TTY；旧拼法 `tui` 给出迁移指引后沿用原行为（`ruukoto --session <id>`／`--demo` 对应原 `tui --session/--demo`）。

```bash
npm start --                 # 任务界面：选择既有会话（不隐式新建）
npm start -- /path/to/dir    # 以该目录为工作区创建新会话并进入
npm start -- config          # 配置中心
```

```bash
ruukoto-code config               # 配置模型与 API key（后台未运行时进入离线模式）
ruukoto-code ~/code/my-repo       # 以该目录为工作区新建会话；首次自动拉起后台
ruukoto-code                      # 回到既有会话（不隐式新建）
ruukoto-code stop                 # 停止后台
```

工作区按真实目录身份归属：符号链接与路径变体复用同一工作区，同名不同目录不合并；一个工作区可以包含多个仓库。目录身份与保护根校验沿用日常工作区入口，代码仓库本身不能用作工作区。相对路径按客户端调用时工作目录解析（`npm run code` 按 npm 脚本的当前目录，通常为本仓库）；路径含空格时加引号；`./config` 与 `-- <路径>` 处理与命令同名的目录。

非 TTY 环境不启动交互页面，改用 `status`／`events`／`submit` 等 CLI 命令；远程使用可登录服务器后启动 TUI，或由桌面客户端经 SSH 转发控制面 socket；不新增远程协议。

### 2.3 按需拉起后台

仅 `ruukoto-code` 的 TUI 入口：打开任务界面（`ruukoto-code`、`ruukoto-code <路径>`、`--session`）时先探测控制面（socket 可连、令牌认证且 ping 确认未停止）。已在运行直接复用，不启动第二个实例；不在运行才拉起 detached 后台进程（标准输出／错误追加到 `<controlDir>/spawn.log`），就绪后打印一行提示并进入界面。

- 拉起的后台与 TUI 生命周期无关：退出 TUI、终端断开都不停止后台或取消任务，显式 `ruukoto-code stop` 才结束。
- 两个终端同时打开时并发拉起由后台实例锁（`<dataDir>/runtime.lock`）收敛为单个实例：败于锁竞争的进程退出，TUI 侧不误判为启动失败，继续探测到胜者就绪后按复用进入（不算本进程拉起）。
- 状态明确，拉起失败均打印错误并非零退出：后台正在退出时等待退出完成后重新连接，不重复拉起；socket 可连而令牌认证不通过 → 后台其实在运行，给出令牌核对指引；服务进程以非实例锁原因提前退出且宽限窗口后探测仍不通过 → 「后台启动失败」并附 spawn.log 尾部（常见原因：未配置可用模型 → 先 `ruukoto-code config`）；到期限仍未就绪 → 等待超时，单独标注且不杀进程。
- 运行中断线仍按既有规则显示重连中，**重连只恢复观察，不会再次拉起后台**；后台不可用要再拉起时重开 TUI 即可。后台明确拒绝（令牌无效、协议版本不符）照旧终止重连并给出修复指引。
- 拉起的后台沿用产品默认 native；显式旧后端覆盖在探测或连接已有后台前拒绝，不自动改写设置。
- `ruukoto`（个人 Agent）不按需拉起：后台由显式 `server` 或 systemd 管理，TUI 打开时仍只连接已运行的后台。
- 手动后台照旧：`ruukoto-code server --data-dir … --agent-dir …` 前台运行，与按需拉起共用同一实例锁（谁在运行谁生效，重复启动被拒绝）。

### 2.4 两个产品的差别

```bash
ruukoto ...                  # 个人 Agent（bin 入口）
ruukoto-code ...             # Coding Agent（bin 入口）：同一 CLI，产品身份经
                             # RUUKOTO_PRODUCT=ruukoto-code 固定注入（仓库内等价于
                             # RUUKOTO_PRODUCT=ruukoto-code npm start -- ...）
```

- 独立档案根 `~/.ruukoto-code/{data,agent,control,pending}`；路径环境变量只读 `RUUKOTO_CODE_DATA_DIR`／`RUUKOTO_CODE_AGENT_DIR`／`RUUKOTO_CODE_CONTROL_DIR`／`RUUKOTO_CODE_PENDING_DIR`，不读对方产品的 `RUUKOTO_*_DIR`；同机并存时目录、实例锁、配置锁、socket 与 owner token 文件各自独立，升级与互停互不牵连。**注意**：`RUUKOTO_OWNER_TOKEN`／`RUUKOTO_OWNER_TOKEN_FILE` 两产品共用（令牌是控制面身份，不是路径归属）；导出了这两个变量的 shell 对两个产品都有认证能力。
- 不启动 QQ/Telegram 连接与个人调度（调度器不创建；状态视图按 ruukoto-code 标注停用原因）；其余命令、控制面与审批机制相同。
- 不提供旧项目写入路径：TUI `/new-project`、在无根目录的旧项目里 `/new`／`/new-session`，以及 CLI `create-project`／`create-session` 只提示改用 `ruukoto-code <目录>` 打开工作区；旧项目保留查看，需要时经 `project migration-preview` 映射到工作区。控制面 op 不变。
- 数据目录归属登记在核心库 meta（`product.type`，首次启动补记）；用另一产品的入口打开已归属的数据目录直接拒绝。
- 打开 TUI 时按需拉起本机后台；显式 `ruukoto-code stop` 才结束后台。

## 3. 控制面命令

除 `server` 外都需要拥有者令牌（`RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 或控制面目录的 `owner.token`）。两个产品共用同一套命令；`ruukoto help` 列出全部。

### 3.1 连接与查询

```bash
export RUUKOTO_DATA_DIR=~/.ruukoto/data
# socket：~/.ruukoto/control/control.sock；认证：RUUKOTO_OWNER_TOKEN 或 control/owner.token

npm start -- status [taskId]          # 快照或单任务（工具操作、审批、产物引用）
npm start -- events                   # 订阅持久事件流（seq 单调递增）
```

### 3.2 任务与会话

```bash
npm start -- create-project my-project
npm start -- create-session my-project /path/to/workdir
npm start -- submit <sessionId> <requestId> "任务输入" \
  [--mode confirm|full_access|auto-review|plan] [--grant <path>:<read|read_write>[:用途];...]
npm start -- set-session-mode <sessionId> confirm|full_access|auto-review|plan
npm start -- switch-mode <taskId> confirm|full_access|auto-review [--grant ...]
npm start -- interrupt <taskId>       # 显式中断运行中/等待确认的任务
npm start -- cancel <taskId>          # 取消排队或活动任务
npm start -- continue <taskId> <newRequestId> "继续输入" [--mode ...]
npm start -- resume-queue <sessionId> # 拥有者确认后恢复队列（并释放遗留占用）
npm start -- confirm <confirmationId> approve|reject
npm start -- read-artifact <taskId> <artifactId> [--offset N] [--length N]
npm start -- read-artifact <taskId> <artifactId> --output /path/to/file
```

`read-artifact` 默认向 stdout 输出一页正文（默认 256 KiB，单页最多 720 KiB）；`--offset` / `--length` 按字节切片。`--output` 自动分页导出完整的 `complete` 产物，核对每页元数据、总字节数及图片的 MIME 与 SHA-256，成功后以 0600 文件原子替换目标；读取、校验或写入失败时保留原目标。`--output` 不能与切片参数同用；`partial` 产物只能切片查看已捕获部分。

`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同参数（含模式与授权范围）重试返回原任务，同键异参返回 `request_conflict`。

### 3.3 工作区与旧项目迁移

```bash
ruukoto project migration-preview <项目id> [--limit N]
ruukoto project migration-preview <项目id> --plan <文件>
ruukoto project migration-apply --plan <文件> [--request-id <id>]
```

`migration-preview` 只读零写入，按源项目列出目录分组、逐会话归属、歧义与异常、安全认领条件与建议计划；会话数可限制，截断如实报告且不可用于认领或生成修订。按建议编写计划文件（`action: map_sessions` 的会话 → 目标分配，或 `claim_source` 的安全认领）后，带 `--plan` 的 preview 校验选择并把绑定最终选择的修订写回计划文件。`migration-apply` 缺省请求键按计划文件内容派生（同一文件重发即原键核实），成功后 `action: "revert"` 的计划文件按回执校验当前值后只恢复显式组织字段。

映射目标必须是根目录含所选会话真实目录的工作区（`existing_workspace`）或通过目录与保护根校验的新根（`new_workspace`，同一真实目录已有工作区时必须复用其 ID）；安全认领仅在来源项目无根、会话集合非空且全为普通 dev、目录全部有效且为同一真实目录、目标即该目录、无占用、无已映射会话时成立（混合／部分／祖先认领拒绝）。

### 3.4 模型

```bash
npm start -- models [--provider provider] [--offset 0] [--limit 100]   # 分页查询安全目录
npm start -- set-model <session> <provider/model> --thinking <level>   # 保存选择
npm start -- submit ... --model provider/model --thinking level        # 本次提交显式指定
```

后台启动可传 `--model provider/model --thinking off`；模型 ID 中后续斜杠会保留。未指定 `--model` 时取 `default-model.json` 持久默认（含思考档位），再回退到目录首个模型；未指定 `--thinking` 时沿用持久默认的档位，没有则为 `off`。显式参数优先：带 `--model`／`--thinking` 运行期间，在线设置的默认模型只写入文件，重启去掉参数后生效。具体合法档位由该模型能力校验。

后台重启后队列仍暂停。旧排队任务若未记录模型，TUI 恢复时显示数量和待补选择，确认后补齐；CLI 需 `resume-queue <session> --model provider/model --thinking level` 显式确认。旧终态任务显示「模型配置未记录」。缺模型、凭据或不支持的档位会拒绝整次变更；目录中认证材料可用不代表远程连通性或额度已验证。

### 3.5 凭据

```bash
npm start -- credentials list
npm start -- credentials add --name N --host H --header H --purpose P --secret-env VAR
npm start -- credentials remove <name>
```

秘密值由可信环境经 `--secret-env` 指定的环境变量提供，不进命令行、模型上下文、事件或日志。用途（purpose）与主机在登记时固定；同名修改或删除在写入前单调推进引用它的入口配置版本，旧连接、旧入站与旧批准失效，A→B→A 轮换不恢复旧代次。

### 3.6 资料授权

```bash
ruukoto grant create --from <项目> --to <项目> --category history|artifact|memory
ruukoto grant list [--all]
ruukoto grant revoke <id>
```

跨项目读取只来自拥有者创建的授权（from/to 项目 + 类别），可查看、可撤销；撤销自后续查询与上下文注入起生效。

### 3.7 长期记忆与历史检索

```bash
ruukoto memory list|show|save|revoke|restore
ruukoto history-search <关键词> [--project P] [--session S] [--task T] [--role R]
  [--since T] [--until T] [--limit N] [--scan-limit N] [--cursor base64]
```

搜索是字面关键词匹配（中文按原文匹配），支持角色／时间／会话／任务过滤、命中数与扫描上限、游标继续；达到扫描上限时如实返回「结果不完整」。

### 3.8 选择记录

```bash
ruukoto selection-records --task <id> | --session <id>
```

### 3.9 SubAgent 工作委派

```bash
ruukoto work list | show | close | cancel
ruukoto work close <工作ID>
ruukoto work cancel <工作ID> [--reason R]        # 停止中拒绝
```

`work show` 的工作对象带取消三列与当前任务状态；`work_get` 的 `messages` 列表查看工作内消息。普通控制面 `submit`／`continue`／`switch-mode`／会话默认模式不能作用于子会话。

### 3.10 文件访问授权

越界读取形成的审批在 TUI 或拥有者 IM 私聊中批准；已登记但未开始的授权可用 `request_file_access` 的正常路径复核，不需要单独命令。

## 4. 配置

### 4.1 配置中心

`ruukoto config` 打开独立配置界面：复用控制面拥有者认证与 TUI 组件，不直接打开核心数据库，也不成为绕过任务审批的入口（任务执行审批仍在任务界面）。在线管理范围：provider 与模型目录（显式端点、SDK 已支持协议、模型列表及上下文／输出参数）、模型 API key、后台默认模型、摘要模型、项目指令／Web Search／资料授权、会话默认模型／思考档位／权限模式、MCP 服务、QQ 配置、服务凭据。

- **并发与修订**：模型配置以 `expected_revision`（`models.json` + `auth.json` + `default-model.json` + `summary-model.json` 的内容指纹）做条件更新；项目／会话／MCP／QQ 沿用各自的 `expected_version`。冲突时要求重新加载，不静默覆盖。
- **模型配置应用时机**：provider、模型目录与 API key 的修改只在没有受影响的 `running`／`awaiting_confirmation`／`queued` 任务或手动压缩操作时应用；检查到应用完成之间，受影响 provider 的新提交、手动压缩与会话模型设置被拒绝（`model_config_busy`，可重试）。占用时返回 `model_config_blocked` 与任务及操作数，不先改文件、不部分应用、不自动取消任务。应用 = 校验 → 写文件（原子、0600）→ 重建 ModelRuntime／模型目录／审查器并同步到各会话驱动；任一步失败回滚文件并保持原配置。删除 provider 或模型前核对后台默认、摘要模型、会话与 `agent_roles` 引用（`provider_in_use`）。
- **摘要模型**：上下文压缩的滚动摘要所用模型，保存为 `<agentDir>/summary-model.json`（`{provider, modelId}`，不存思考档位）。设置后，main 与开发会话较早的对话（含工具结果）会发给该模型的提供方做摘要。
- **秘密**：API key 输入遮蔽；响应只展示是否配置与必要元数据；秘密不进入日志、事件、命令行参数或重载状态文件。模型 API key（`auth.json`）与服务凭据（`credentials.json`）分开管理。
- **项目分区**：ruukoto-code 的「项目」分区把工作区列在前（标注「工作区」并展示根目录），旧项目列在后（标注「旧项目」）；ruukoto 产品平铺项目名称。指令与 Web Search 保存携带读取时的设置版本；「MCP 服务」入口只列本项目服务。
- **离线模式**：后台不可达时（或 `--offline`）进入有限离线配置：只做模型目录、默认模型、摘要模型与 API key 的初始化／修复，直接写 `<agentDir>` 下文件。互斥按规范化 agentDir 的配置锁（`<agentDir>/config.lock/`）判定：后台运行时持有该锁（不同 dataDir 共用 agentDir 也被覆盖），socket 不可达或认证失败不证明后台已停；无法取得独占时明确失败，不放宽权限、不改属主。

### 4.2 权限模式

模式按会话设默认值、按任务生效，TUI 顶部持续显示。切换只在无执行中工具的边界生效，递增权限版本并使等待中的审批失效。

| 模式 | 行为 |
| --- | --- |
| 请求确认 `confirm`（默认） | 工作区内读写与检查自主执行；越出工作区、未授权网络或凭据、对外写操作逐次请拥有者确认。批准绑定目标、内容指纹、方法与完整 URL，单次消费 |
| 自动审查 `auto-review` | 执行环境同上；越界的文件读取与无凭据 GET/HEAD 先经一次独立的无工具审查调用裁决，失败或拿不准一律转拥有者 |
| 完全访问 `full_access` | 由拥有者在可信入口选择；以启动账户无任务沙箱运行，所有已开放工具免操作审批，不额外赋予 OS 权限；模型输入不能提供权限升级来源 |
| 计划 `plan` | 仅普通开发会话；沿用自动审查的环境与审批，要求只调研不修改，持续到手动切换。保留的 `bash` 仍可能写入，不是全面只读保证 |

受限模式使用原生沙箱，默认无网络，只开放工作区、任务级授予与宿主钉定的只读范围；核实执行单元停止后才释放占用和临时资料。完全访问的文件、HTTP、MCP、应用数据、通知与服务工具均免操作审批，仍核实活动任务、权限版本、目标与修订，并保存真实授权来源；同账户的后台数据、凭据与令牌可被完全访问命令直接访问。

### 4.3 项目设置

```bash
ruukoto project set-instructions <项目id> <文件...>    # 工作区相对路径
ruukoto project web-search <项目id> on|off             # 默认启用
```

项目指令从 `project.rootDir?.cwdReal ?? session.cwdReal` 起经受限读取钉版（realpath 后必须仍在基准目录内），任务内固定、下一任务重新读取。项目指令与 Web Search 共用 `projects.settings_version`：保存经 `Store.updateProjectSettings` 在同一事务核对可选期望版本、更新同一行、递增同一版本并追加 `project.settings_changed` 事件；不符 = `version_conflict`，不改配置、无事件；同值保存幂等。

### 4.4 子代理角色文件

两个产品分别读取本实例 `<agentDir>/agents/*.md`，不自动扫描仓库。文件名是小写 kebab-case 角色名，同名覆盖内置 general/reviewer；新增文件新增角色。普通委派和工作流的 `role` 从同一目录选择：首次省略为 general，继续或复用沿固定角色；实际工具与权限按来源、角色及宿主约束求交。

```markdown
---
description: 阅读给定资料并给出有依据的结论。
---
根据委派目标阅读资料，报告结论、依据与未验证项。
```

`description` 必填非空，正文必填；可选 `tools` 为不重复工具名称列表，省略表示继承；`permissions` 可含 `mode`（默认 inherit，另有 confirm、auto-review、full_access）和布尔 `protect_source`（默认 false），保护不能与 full_access 同时要求。未知字段或非法 YAML 明确报错，坏覆盖不会使用内置兜底。文件须为不超过 64 KiB、单一硬链接的普通文件，目录及文件符号链接均拒绝。

主模型的子代理角色目录显示有效名称与诊断；拥有者控制面查询 `list_subagent_roles` 返回目录、字段及错误。修正文件只影响后续新建身份或新启动工作流；原子代理继续、复用、消息与重启沿完整快照，换角色须新建身份。GitHub 宿主固定评审不使用用户角色覆盖。记录损坏时保留历史并报告拥有者，不从当前文件猜测恢复。

代码修改与代码审查委派都显式给 `target`；无目标使用独立目录与获准资料。Git 副本包含当前未提交内容，忽略文件和依赖不复制；子代理报告缺依赖后在获准位置准备。内置 reviewer 用受限模式保护原目录，允许在副本写检查产物。普通汇总只应用子增量；来源同文件后来变化会冲突并保留成果。大小写不敏感文件系统的仅大小写重命名可能被 Git 套用预检拒绝，成果仍保留。非 Git 普通执行用原目录串行，需要保护来源则拒绝。普通委派与工作流均拒绝旧 `mode`；用 `role` 选角色、`target` 指定代码目标。工作流冻结验证使用 `verify`，与 `target` 互斥，角色不改变宿主验证限制。

## 5. 启用各入口

### 5.1 Telegram owner 入口

```bash
TG_TOKEN=123456:ABC... ruukoto credentials add --name tg --host api.telegram.org \
  --header none --purpose telegram_bot --secret-env TG_TOKEN
ruukoto telegram configure --credential tg --user-id <owner user_id> [--chat-id <chat_id>] [--api-base https://...]
ruukoto telegram enable | disable | status
```

bot token 只在 CredentialStore（purpose=`telegram_bot`，host 须与 API 地址一致；配置后 scope 收紧到 `telegram_bot`）。`--api-base` 缺省官方端点，可指向受控反代（必须 https，http 仅限回环）；Node `fetch` 不读 `HTTP(S)_PROXY`，国内服务器需要反代或网络层代理。任何配置变化递增 `config_version` 并即时重连，重新配置把轮询偏移归零（平台重投由外部 id 去重）。`ruukoto telegram status` 显示配置视图、在线状态、最近错误与偏移，不含 token；回复记录用 `ruukoto notify list|show`（`sourceKind = owner_reply`）查看。

### 5.2 QQ owner 私聊

```bash
QQ_ONEBOT_TOKEN=... ruukoto credentials add --name qq-onebot --host 127.0.0.1:3001 \
  --header authorization --purpose qq_onebot --secret-env QQ_ONEBOT_TOKEN
ruukoto qq configure --endpoint ws://127.0.0.1:3001 --self-id <登录QQ号> \
  --credential qq-onebot --owner-id <拥有者QQ号>
ruukoto qq enable
ruukoto qq status
ruukoto notify list
```

配置中心的 QQ 页面也可绑定或清除拥有者 QQ 号。`--no-owner` 清除私聊绑定；`qq disable` 停用整个 QQ 入口。私聊必须有 token，登录号与 owner 必须不同。`qq inbox`／`qq outbox` 只显示旧群归档记录。核心群聊已退役，`qq group add|remove` 已删除，旧命令只打印退役提示。

### 5.3 私聊图片入站

无需单独启用：仅个人 Agent 的 Telegram／QQ 拥有者私聊接收 JPEG、PNG、WebP，每条最多 4 张，每张最多 8 MiB。不转码或缩放；GIF、SVG、伪造 MIME、大小或数量超限永久拒绝。所选模型不支持 image 时媒体消息记为 `rejected` 并回执 `image_input_unsupported`。

### 5.4 通用定时任务

main 使用 `schedule_create` 登记时间规则与自足任务说明。例如定时新闻查询由该次任务调用普通搜索工具完成：

```json
{
  "create_key": "daily-tech-news",
  "rule": { "kind": "daily", "time_zone": "Asia/Shanghai", "time": "09:00" },
  "instruction": "检索人工智能与开源软件的近期新闻，核对原始来源并汇总带链接的摘要。",
  "reason": "每天独立执行一次已约定的新闻查询"
}
```

计划保存创建任务当时的访问模式与可信拥有者回报目标；模型不能指定模式或接收者。每次到期建立新的独立上下文，只输入说明与创建时明确提供的资料，保留个人业务工具与委派资格；不自动复制主聊天或上次运行历史。主会话改模式不改写已有计划。完全访问运行免操作审批，受限运行沿原策略等待决定，不阻塞主聊天；无 IM 时可在 TUI／控制面回应。

整项运行及其派生任务结束后，默认向保存目标回报一次最终结果或失败；没有目标仍可创建，结果留在运行记录。目标失效不改发新目标。同计划最多一项未完成运行，忙碌时合并漏过周期，离线且无在途时最多补最近一次；发送晚到不阻塞下次运行。修改时间或说明需取消后重建，取消同时停止未来触发与该计划的整项在途工作，保留成果及未核实占用。定时任务使用原有工具前置，新闻任务需要可用的 Web Search 凭据。

### 5.5 调度与通知查看

```bash
ruukoto schedule list|show|cancel
ruukoto notify list|show|cancel
```

每页 ≤50，列表不带正文。计划详情显示创建模式、固定回报目标与最近独立运行结果；控制面不获得发送或改目标能力。

### 5.6 Web Search

```bash
ruukoto credentials add --name tavily --host api.tavily.com --header authorization \
  --purpose tavily_search --secret-env TAVILY_API_KEY
ruukoto project web-search <项目id> off     # on 恢复；默认对所有项目启用
```

秘密值为 API key，工具按 `Bearer <key>` 注入；值不进入模型上下文、事件、日志、历史正文或错误文本。未配置、host 或用途不匹配一律拒绝调用且不发送请求。任务开始固定工具清单：禁用中的项目任务不注册 `web_search`；任务内禁用立即阻止后续调用；重新启用从下一任务生效。

### 5.7 MCP 服务

```bash
ruukoto credentials add --name github-mcp --host api.githubcopilot.com \
  --header authorization --purpose mcp --secret-env GITHUB_MCP_PAT
ruukoto mcp configure --project <id> --name github \
  --endpoint https://api.githubcopilot.com/mcp/readonly --credential github-mcp \
  --tools get_me,get_file_contents [--expected-version N]
ruukoto mcp list [--project <id>]        # 脱敏视图
ruukoto mcp check <service-id>           # 连接检查 + 工具发现，标注每个远端工具是否在允许列表
ruukoto mcp disable <service-id> | enable | remove <service-id> [--expected-version N]
```

MCP 凭据用途固定为 `mcp`，host 须与服务端点一致，经 authorization 头以 Bearer 注入；配置服务时 scope 自动收紧到该项目 + mcp 操作，已有冲突 scope 拒绝配置。首个接入对象为官方远程 GitHub MCP。

GitHub MCP 首次配置：端点 `https://api.githubcopilot.com/mcp/readonly`（URL 路径 `/readonly` 为服务端只读开关）；凭据为独立只读 PAT（`purpose=mcp`、`host=api.githubcopilot.com`）。允许列表按 `mcp check` 实际发现的工具名精确填写（服务端工具集随版本变化，以发现结果为准）；建议只开放身份查询、仓库文件、PR、Issue、Actions 与 Checks 的读取类别。仓库可访问范围由 PAT 权限约束：通用客户端未实现参数级仓库限制，项目级启用不等于令牌内的单仓库隔离。

### 5.8 GitHub PR webhook

先登记独立签名秘密，`GITHUB_WEBHOOK_SECRET` 由调用环境提供，值不写进启动 JSON、命令参数、任务正文或日志：

```bash
ruukoto credentials add --name github-events --host github.com \
  --header x-hub-signature-256 --purpose github_webhook --secret-env GITHUB_WEBHOOK_SECRET
```

后台启动时通过 `--github-webhook-config /path/to/github-webhook.json` 显式启用：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "credential": "github-events",
  "repositoryIds": [123456789],
  "notifyChannel": "telegram"
}
```

```bash
ruukoto server --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent \
  --execution native --github-webhook-config /path/to/github-webhook.json
```

`port`、`credential` 和非空 `repositoryIds` 必填；仓库范围使用正整数 ID。`host` 默认 `127.0.0.1`，`notifyChannel` 可选 `telegram` 或 `qq_private`，默认 Telegram。未传文件即不开监听，开发实例不自动继承这项配置。监听路径固定为 `POST /github/webhook`；对外提供 HTTPS 时由部署侧反向代理到该入口。GitHub webhook 使用 JSON 与相同 secret，并订阅 Pull requests 事件。

启用配置同时授权一次固定 owner 摘要，因此应先配置并启用所选 Telegram 或 QQ 私聊渠道。GitHub MCP 另行配置到 **main** 角色绑定的项目，使用自己的读取凭据和工具允许列表。

### 5.9 Jev 上下文筛选实验

实验按项目配置，默认关闭。先登记 TypeSafe API key，再在 `ruukoto config` → 项目 → 选择项目 → Jev 上下文筛选实验中选择凭据引用并启用：

```sh
ruukoto credentials add --name jev-myproject --host api.typesafe.ai \
  --header authorization --purpose jev_context --secret-env JEV_API_KEY
```

`JEV_API_KEY` 由拥有者的可信环境提供，值为原始 key，宿主发送时添加 `Bearer`。每个 Jev 凭据只绑定一个项目，普通 `http_request` 不可借用。缺少有效凭据时不发送请求；QQ 群聊和 chat 角色项目不开放本实验。启用从下一任务生效；停用阻止后续 Jev 请求并丢弃迟到结果，已经发送的内容无法撤回。当前阈值为 0.5，单次超时 2 秒；最多评估 24 个候选。

### 5.10 服务器服务管理

main 与独立定时会话可检查服务器部署白名单内的服务状态，完全访问免操作审批，其他模式逐次批准执行管理动作（首版仅 restart），main 可命中经核实的长期授权，定时会话不继承长期授权。要求产品 ruukoto + Linux + 显式部署配置齐备（`RUUKOTO_SERVICE_HELPER`／`RUUKOTO_SERVICE_POLICY` 经后台单元 drop-in 注入，只设一个拒绝启动）。安装步骤见 [deploy/systemd/README.md](../deploy/systemd/README.md)。

```bash
ruukoto service-grant list|show|revoke
```

拥有者可经原 IM 平台的待审批把某次 service restart 审批保存为限定长期授权（`/approve-standing`），之后独立任务命中完全相同范围时自动放行，范围外仍逐次审批。入口停用后仍可管理遗留记录。

### 5.11 工作流问题与回报

已有工作流提出问题后，可在发起时的拥有者私聊入口按通知中的完整 ID 和版本答复：`/workflow-question <运行ID> <步骤键> [字节偏移]` 查看问题、约束和已有回答；`/workflow-answer <运行ID> <步骤键> <问题运行代次> <问题版本> <JSON回答>` 提交，例如回答字符串写为 `"yes"`。问题运行代次在建立时固定，其他分支进度不改变它；暂停、取消、过期版本、错误入口及资料撤销会拒绝回答。业务回答不批准工具，需要工具批准时仍使用原审批入口。

主 Agent 可等待明确的后台任务或工作流，收到任一结果或需介入时继续处理；超时可再次等待，新消息打断本次等待但后台工作继续。

结果由有效父轮继续汇总，父轮中断则沿原键补报；同来源多个目标共用一份总结，dev 留在原会话，main 有原 IM 来源时回原入口、CLI/TUI 来源留原会话，定时来源等名下全部运行后只走调度最终回报；平台字符上限内优先保留宿主终态、覆盖、停止核实与失败事实，终态事实取代启动和中途的旧状态。停止已核实不代表写入效果已知。`delivery.status=reported` 表示汇总及适用的通知登记完成，真实发送状态用 `ruukoto notify list|show` 查看；`workflow_question` 是问题通知，最终 main 回报是 `owner_reply`。failed/effect_unknown 不自动重发，入口换代不改目标。暂停、取消与未核实停止事实保留在运行记录，已有外部效果不回滚。

定义文件在实例 `<agentDir>/workflows/<名称>.js`，名称为 1–64 位字母数字及 `_`/`-`，首位为字母数字。保存入口自动写入接口版本首行，后面是 async 函数体，接收 JSON `input`，可调用 `agent`、`ask`、`integrate`、`progress`；先让模型用 `workflow_instructions` 读取编写说明。文件/临时脚本均须通过普通文件、UTF-8、128 KiB 与 QuickJS 语法校验，符号链接和越界名称拒绝，不回退旧版本。每次运行固定版本、参数及来源授权；编辑当前文件只影响新请求。模型可在当前可信任务内自主使用，计划模式、子任务和工作流步骤不能发起嵌套运行。

两产品均可用 CLI 管理定义和运行；下面用 Coding Agent 示范，个人产品将命令名前缀换成 `ruukoto`。启动固定当前会话的模型和模式；需改变授权先用已有模式入口选择，启动参数不能回填授权。

```sh
ruukoto-code workflow save batch --script-file ./batch.js --request-id save-batch-1
ruukoto-code workflow definitions
ruukoto-code workflow definition batch
ruukoto-code workflow run batch --session sess_x --request-id batch-1 --input-json '{"question":"继续?"}'
ruukoto-code workflow list --session sess_x
ruukoto-code workflow show wfrun_x
ruukoto-code workflow logs wfrun_x
ruukoto-code workflow step wfrun_x step-key
ruukoto-code workflow question wfrun_x question-key
```

`save` 新建时不填 `--expected-digest`；更新须用 `definition` 返回的当前 digest。正文/问题/步骤可用 `--offset`、`--length` 按 UTF-8 字节分页，详情步骤用 `--step-offset`；定义历史用 `--version-offset` 按返回的 `nextVersionOffset` 续读，每页 100 项。列表/详情只含送达摘要，完整最终事实和回报正文用 logs 分页读取；历史脚本用 `workflow version <定义ID>`。运行参数也可 `--input-file` 读取 JSON；临时脚本以 `workflow run --script-file F --title 名称 --session S --request-id K` 启动，可用 `--description` 填简短说明；命名定义的名称固定，不接受 `--title` 覆盖。无版本标记的旧定义可查，须按 `role` / `target` / `verify` 更新正文，再用 `save` 与当前摘要显式保存新版；旧运行保留查询与取消，不恢复或自动重跑。临时脚本的旧 `mode` 调用会被拒绝，先前步骤的副作用仍保留。定义不可读/语法失败先修文件，`script_validator_unavailable` 先运行 `npm run build:script`；模型或执行入口失败先检查配置。

| CLI 后续操作 | 必填字段 |
| --- | --- |
| `workflow answer <运行ID> <步骤键>` | `--run-version` 填问题建立代次，`--question-version` 填问题版本，`--request-id`、`--answer-json` 或 `--answer-file` |
| `workflow pause/resume/cancel <运行ID>` | `--expected-version` 填 show 当前版本，`--request-id`；resume 的 `--clock-confirmed true`、`--stops-confirmed true` 只在确已核实时提供 |
| `workflow budget <运行ID>` | `--expected-version`、`--request-id`、`--max-attempts`、`--duration-ms`；调整不自动恢复 |
| `workflow find` | 原启动的 `--session`、`--request-id` |
| `workflow saved` | 原保存的 `--request-id` |

所有写操作用稳定请求键。应答丢失先 find/saved 或 show 核实；同键重放返回原记录，异参冲突，不能换新键把未知写入重做。停止未核实须先核实执行/占用，时钟未核实也须单独确认；效果未知、写入缺结果、来源失效或重放分歧不会因 resume 确认自动解除。取消保留历史及成果，故障处理见[工作流模块](modules/workflows.md#不变量与失败处理)。当前 schema 45/协议 31 严格拒绝旧档案和客户端，原资料保留并用匹配代码查阅。

TUI 用 `/workflow` 打开侧栏：默认列出当前会话全部活动运行和最近十项结果，历史和长列表可续读。选运行后进入详情，查看步骤、日志、业务问题及独立的停止核实、效果未知和最终回报状态，再选择回答、暂停、恢复、取消或预算；名称、含毫秒时间、展示序号和显式说明帮助辨认同名运行。选“启动工作流”后选择已保存定义、填写 JSON 业务参数与可选简短说明，再确认启动；编辑脚本通过文件或 Agent。Enter 确认、↑↓ 选择、PageUp/PageDown 阅读正文，Esc 逐层返回并在根层关闭，浏览层也可用 q 返回。宽度至少 120 列时侧栏与聊天共存，Tab 切换焦点；窄屏以独立窗口显示同一所在层，Tab 可回聊天，缩放保留选择。关闭侧栏或客户端不取消运行。稳定键、原版本和参数由程序在发送前落盘，应答丢失、重连和客户端重启先只读核实原提交；明确未接收后可选择原键原参数重试，实例变化或记录损坏时保留待核实，不向新库重发。过期操作退回最新详情，重新选择并确认。

个人 IM 只接受绑定拥有者在原入口发送的完整命令，运行用完整 ID 定位；引用、转发、来源不符、旧代次、格式错误或定位歧义不改变运行。命令仍在原始文本进入模型前处理，控制回执与意图同事务提交，平台重投不重复执行。

| IM 命令 | 用途 |
| --- | --- |
| `/workflow-definitions [列表偏移]`、`/workflow-definition <名称> [字节偏移]` | 查看命名库和脚本；保存可请模型调用保存工具或用 CLI/TUI |
| `/workflow-run <名称> <JSON参数>` | 显式启动，不占一个模型发起轮次 |
| `/workflow-list [列表偏移]`、`/workflow-show <完整运行ID> [字节偏移]` | 查看本入口运行与当前版本/等待原因 |
| `/workflow-logs <运行ID> [字节偏移]`、`/workflow-step <运行ID> <步骤键> [字节偏移]` | 阶段与步骤结果 |
| `/workflow-pause/resume/cancel <运行ID> <当前版本>` | 暂停、恢复或取消；resume 可加显式 JSON 核实项 |
| `/workflow-budget <运行ID> <当前版本> {"maxAttempts":150,"durationMs":7200000}` | 拥有者调整预算；模型不能提高 |

问题答复仍使用本节开头的 `/workflow-question`、`/workflow-answer`，不批准工具。配置变化不改发目标；未送达事实留在运行/outbox，可用 CLI 查看，不能把发送登记当作平台成功。

## 6. 导入旧实例

含工作流运行、步骤、执行绑定、问题或控制记录的源实例明确报 `workflow_import_unavailable`；保留原档案用匹配代码查阅，当前导入不迁移工作流授权与执行。只有定义版本的资料不随普通资料导入。

两个方向都必须离线执行：preview／apply／revert／list 都要求目标后台已停止（CLI 持目标实例锁运行，不走控制面）；源实例全程只读——源后台存活（或持锁身份无法核实）时拒绝，快照 = 把 `ruukoto.db` 及 WAL 侧车逐文件复制到临时目录后在副本上核实当前格式，源目录逐文件 sha256 不变。

### 6.1 开发资料迁入（ruukoto-code）

`ruukoto-code legacy-import` 只在 **ruukoto-code** 产品下可用，把旧 ruukoto 实例中的开发资料迁入 Coding Agent 档案。

```bash
ruukoto-code legacy-import preview --from <源数据目录> [--plan 计划文件]
ruukoto-code legacy-import apply --plan 计划文件 [--request-id <id>]
ruukoto-code legacy-import revert <导入ID>
ruukoto-code legacy-import list
```

拥有者在计划文件中修改 `renames`（重名项目改名）与 `personal_memories`（显式选中发布的个人记忆）后 apply：先查回执／核修订（源或目标变化即 `revision_conflict`），再备份目标库 `<dataDir>/migration/<导入ID>/target-before.db`（`VACUUM INTO`，回执记录 sha256），复制文件后单事务入库并写回执与条目账本；中断后用同一计划重跑即可，同键重放返回原回执。

导入范围是 allow-list，行 ID 原样保留：源项目内的普通 dev 会话及其任务、工具操作、审批、产物、选择记录、压缩点、事件与 SubAgent 一层；项目配置、范围内记忆、双端都在导入范围的资料授权、MCP 与 Jev 配置（缺凭据绑定时以停用导入）。不导入角色绑定会话、QQ 群会话与 main 资料、历史索引、目录占用、agentDir 全部配置与凭据。导入不调用模型、不重放外发。

整库恢复为手工路径：

```bash
ruukoto-code stop  # 确认后台已停止
cp <dataDir>/migration/<导入ID>/target-before.db <dataDir>/ruukoto.db
rm -f <dataDir>/ruukoto.db-wal <dataDir>/ruukoto.db-shm
# 复制的 JSONL 与产物正文如需一并移除，按回执 report.files 逐项删除
```

### 6.2 个人资料迁入（ruukoto）

`ruukoto legacy-import` 只在 **ruukoto** 产品下可用，把旧 ruukoto 实例中的个人资料迁入**全新** ruukoto 实例——main 会话、应用数据、调度、平台绑定与必要凭据；旧 coding/chat 档案与发送事实随迁为只读归档。目标必须未初始化：目标后台启动过（有自有角色行与 main 会话）即拒绝；源或目标后台存活、同一路径、同一实例 ID 也都拒绝。

```bash
ruukoto legacy-import preview --from <源数据目录> [--plan 计划文件]
ruukoto legacy-import apply --plan 计划文件 [--request-id <id>]
ruukoto legacy-import revert <导入ID>
ruukoto legacy-import list
```

preview 列出**交接清单**（平台配置含 `config_version` 与 telegram 偏移、活动调度、生效中的长期授权）、应用数据与绑定核对、会话归属、各项收尾计数、记忆与授权分类、MCP／Jev 停用项、凭据动作（copy/skip/conflict）、归档计数、冲突与修订值。**必要凭据**：平台配置引用的绑定与 purpose `github_webhook` 的绑定从源 `credentials.json` 合并进目标（同名同值跳过、异值拒绝，报告只记 sha256）；MCP／Jev 凭据不复制。

**拥有者务必在 apply 后停止并退役旧实例：不得再启动旧后台消费平台入站或调度**，否则两端会各自轮询同一 bot、独立触发同一批通知——这是一次性切换，导入工具不改源实例一字。GitHub webhook 监听地址为启动参数（`--github-webhook-config`），需要在目标启动时重新给出；GitHub 侧 webhook URL 指向新地址属拥有者的平台外操作。

整库恢复同样为手工路径：

```bash
ruukoto stop  # 确认后台已停止
cp <dataDir>/migration/<导入ID>/target-before.db <dataDir>/ruukoto.db
rm -f <dataDir>/ruukoto.db-wal <dataDir>/ruukoto.db-shm <dataDir>/agent-data/main.db*
# 复制的 JSONL/产物/归档文件需一并移除时，按回执 report.files 逐项删除；
# 凭据摘除按回执 report.credentials 逐项核对
```

## 7. 交互终端

顶部是项目／会话／工作目录／连接状态／权限模式／执行后端，中间是消息与工具记录，底栏是权限模式、token 用量与模型。TUI 只经本机 socket + 拥有者令牌连接后台，不加载模型凭据、不读数据库。

### 7.1 输入

| 按键 | 行为 |
| --- | --- |
| `Enter` | 提交 |
| `Alt+Enter` / `Shift+Enter` / `Ctrl+J` | 换行（部分终端不上报 Shift+Enter） |
| `Shift+Tab` | 循环切换会话默认模式（Ask for approval → Full access → Auto review → Plan） |
| `Ctrl+C` | 有草稿先清空草稿；空草稿退出客户端 |
| `PageUp` / `PageDown` / 滚轮 | 翻页；滚动后新输出不会把视口拉回底部 |
| `End` | 回到最新位置，恢复跟随 |

选择与查看的悬浮层与窗口均可用 `q` 或 `Esc` 关闭；窗口与选择悬浮层打开时不触发 `Shift+Tab`。命令以 `packages/tui/src/tui/commands.ts` 的条目表为准：补全、`/help`、派发、回显、是否作为任务输入与是否保留成功结果都由条目推出。

### 7.2 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令与快捷键说明 |
| `/todo` | 打开或关闭右上角工作清单悬浮层 |
| `/resume` | 切换当前项目中的会话 |
| `/project` | 切换项目（ruukoto-code 为工作区／旧项目列表） |
| `/new-project <名称>`、`/new-session <目录>`、`/new` | 创建项目／在当前项目创建会话／在当前工作区创建会话 |
| `/branch [名称]` | Coding Agent 从当前普通开发会话的已落盘历史建立独立会话并切换 |
| `/compact [prompt]` | Coding Agent 主动摘要当前空闲普通开发会话，可补充本次摘要重点 |
| `/history` | 重新加载当前会话历史；滚动到顶部自动加载更早历史 |
| `/artifact <id 前缀>` | 查看工具产物正文（按字节分页） |
| `/approvals` | 待处理审批；详情内 `a` 批准、`r` 拒绝，`Esc`／`q` 关闭不等于拒绝 |
| `/interrupt [taskId]`、`/cancel <taskId>`、`/continue [taskId]` | 停止与继续任务 |
| `/resume-queue` | 恢复已暂停的会话队列 |
| `/model` | 选择提供方／模型／思考强度，作用于之后提交的任务 |
| `/mode` | 选择会话默认模式，作用于后续新任务 |
| `/status` | 查看当前任务详情 |
| `/search <关键词>` | 字面搜索会话历史原文 |
| `/memory <子命令>` | 长期记忆：list / show / revoke / restore |
| `/context` | 上下文窗口分解（各部分占比与压缩点） |
| `/prompt` | 本会话的模型请求列表与每次调用的 prompt |
| `/skill <名称> [参数]` | 显式调用技能（不带名称时同 `/skills`） |
| `/skills` | 技能库与诊断 |
| `/workflow` | 工作流侧栏：选择运行、历史、定义启动与逐层操作；Tab 切换聊天 |
| `/qq <子命令>` | QQ 入口：status / enable / disable / groups / inbox / outbox（后三者为旧群归档） |
| `/quit` | 退出客户端（后台任务继续运行） |

Telegram／QQ 私聊不识别 `/skill:`。`/plan` 已移除，按未知命令处理；CLI/API 的 `/plan …` 仅作为普通输入。

会话选择列表每项两行：首行优先使用持久名称，其余使用最早用户输入（无输入时显示未命名会话），次行显示距最后任务活跃时间的间隔；项目选择列表首行显示「项目名 · 会话数」，次行显示会话的工作区路径。切换普通开发会话时沿用切换前选择的模式（含 Plan）、模型和思考档位，保存为目标会话的默认设置；提交新任务会等待设置保存完成。分支创建后的自动切换保留后台继承的设置。

`/branch 中文 名称` 保留名称内空格，同名会话以 ID 区分；省略名称时生成「父标题 · 分支 N」。它要求普通工作区会话或已映射旧会话，未映射来源先走工作区映射。后台固定已落盘历史，排除部分尾记录及活动任务未完成的工具批次，并显示实际分支点与排除说明；无可复制消息时等待落盘或使用 `/new`。成功后编辑器为空，失败保留父选择与草稿；命令与结果留在发起会话的命令历史。

父子共享工作目录，文件改动共同可见，同目录任务继续串行；分支不创建 Git 分支或工作副本，也不回滚文件。它不发模型请求、不复制任务、队列、审批、临时授权或用量。默认模型、思考档位、运行模式与确认工具独立继承；项目配置继续共享原来源。有效压缩点与工作清单各自延续，原图片、产物和已完成 SubAgent 结果按限定来源只读查询，原工作后续结果不进入该集合；管理原工作仍要回到其父会话。

`/compact` 主动生成滚动摘要，保留最后一个完整 assistant 回复批次及其后的原文尾部，工具调用与结果整批保留。`/compact 保留数据库迁移细节` 将指引补在固定摘要规则之后；首尾空白去掉，内部空格和换行保留，仅本次生效。空会话、没有可摘要内容或没有新增覆盖且未提供指引时无需压缩；已有摘要且提供指引时可重新聚焦旧摘要，无法恢复旧摘要遗漏的细节。完整历史仍可通过 `/search` 与历史工具查回，JSONL 不改写，命令与结果只保存到 TUI 命令历史。

手动压缩使用配置的摘要模型；未配置时使用接收时的会话模型，较早消息、旧摘要和本次指引会发给其提供方。一次尝试、最长 180 秒，输入预算不足、模型不可用、空输出、触顶或失败时不替换原有效点。会话有排队、正在启动或活动任务时拒绝压缩；压缩期间同会话新提交与继续被拒绝且输入保留，其他会话照常使用，也可查看或切换会话。`/interrupt` 取消当前在途压缩，已提交成功则报告成功；断开客户端不取消操作，后台停止或异常重启将未完成操作记为中断，不自动重调摘要模型。

成功结果显示摘要覆盖条数、实际摘要模型与历史上下文前后估算；估算包含完成历史视图与摘要，不含下一任务的项目指令、技能、记忆、工具定义及新输入，也不保证一定下降。`/context` 仍查询最近一次主模型调用，下一次实际调用才反映新点；手动压缩不会新增主模型调用或改写既有选择记录。

### 7.3 断开与重连

退出只关闭客户端，后台任务继续执行。重连后从后台重建快照、历史及任务事件，恢复思考、工具、完整正文和完成状态的顺序，按事件和消息身份去重；不自动新建任务、不恢复暂停队列。事件序号缺口或游标过旧时自动重新同步。

提交前生成 `request_id` 并把完整请求原子保存到拥有者私有目录（默认 `~/.ruukoto/pending/`，`RUUKOTO_PENDING_DIR` 可覆盖，0600）；应答丢失时显示「接收结果待核实」，按 `session_id + request_id` 核实（断线的等重连后，连接仍在的当场核实这一条）：已接收则关联原任务，明确未接收才以原键原参数重试；记录绑定数据实例标识，换新数据库后不会向空后台重发。未发送或后台明确拒绝时清除记录并恢复输入。

`/mode`、`/model`、审批应答丢失时：连接仍在立即查询后台状态，已断线则提示结果未知、以重连快照为准，都不自动重发。

分支请求在待确认目录的 `branches/` 保存原键及参数；应答丢失或退出重进后按原键查询，必要时重用原快照恢复发布。后台更换数据实例时保留记录供核实。已发布分支的历史缺失会明确拒绝，恢复历史后再继续，不能用空会话冒充原分支。

手动压缩请求在待确认目录的 `compactions/` 保存发起会话、原键、参数和数据实例身份直到终态。应答丢失、重连和退出重进先查询原请求，只有后台明确未接收才按原键重发；数据实例变化时保留原键供核实。另一客户端可查询当前会话最近一次压缩结果；结果归发起会话，切走后不会强制切回。

### 7.4 终端安全与恢复

消息、工具日志与审批参数渲染前剥离终端控制序列（CSI/OSC/APC，含 OSC 52 剪贴板写入与擦屏／光标控制），不可见控制字符显示为转义形式；只改变展示，不改动历史与执行参数。

正常退出、`SIGTERM`、`SIGHUP` 与可处理异常都会关闭 socket、恢复 raw mode／光标／屏幕，不发送 `stop` 或取消任务。进程被强杀（SIGKILL）时无法执行清理回调：如终端显示异常，执行 `reset` 或 `stty sane` 恢复。

## 8. 开发实例

`npm run dev` 启动 ruukoto 开发后台，`npm run code` 启动 ruukoto-code 开发后台并默认打开 TUI；两者都支持 `--config` 与 `--import-models <目录>`。隔离档案、源码重载与退出行为见[开发说明的开发实例一节](development.md#开发实例)。

## 9. 数据目录

以 `ruukoto` 默认值为例；`ruukoto-code` 结构相同，根目录换成 `~/.ruukoto-code/`。

```
~/.ruukoto/data/      0700  元数据库、会话 JSONL、产物、实例锁
~/.ruukoto/control/   0770  控制面 socket（0660）与拥有者令牌（0600）
~/.ruukoto/agent/     0700  models.json、auth.json、credentials.json、default-model.json
~/.ruukoto/pending/   0700  待核实的提交记录
```

目录可用 `RUUKOTO_{DATA,AGENT,CONTROL,PENDING}_DIR` 覆盖；`ruukoto-code` 只读 `RUUKOTO_CODE_*_DIR` 这一组，跨产品打开数据目录会被拒绝。执行配置（`RUUKOTO_EXECUTION_BACKEND`）及常驻 user manager 环境见部署文档。拥有者令牌文件路径可经 `RUUKOTO_OWNER_TOKEN_FILE` 指定（显式使用其他令牌文件时）。

完整布局、schema 版本与职责边界见[存储与身份](modules/core.md)。

## 10. 故障排查

### 10.1 后台起不来

| 现象 | 处理 |
| --- | --- |
| 「后台启动失败」并附 spawn.log 尾部 | 常见原因是未配置可用模型，先跑 `ruukoto-code config`；spawn.log 在 `<controlDir>/spawn.log` |
| socket 可连但令牌认证不通过 | 后台其实在运行；核对 `RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 与控制面目录的 `owner.token` |
| 等待超时 | 到期限仍未就绪，单独标注且不杀进程；确认 native 平台前置、宿主工具与 worker 构建产物可用 |
| 重复启动被拒绝 | 同一实例锁已在运行（`<dataDir>/runtime.lock`）；`ruukoto-code stop` 或确认已在运行的后台 |
| `schema_version_unsupported` | 档案版本与代码不一致；保留原档案并用匹配代码查阅，当前代码使用独立新档案，不修改版本号或补字段 |
| 实例锁无法核实 | 按 `owner.json` 的 `processIdentity` 核实进程启动身份；无法核实时保留锁并要求人工处理 |
| 队列不自动恢复 | 后台重启后有排队任务的会话暂停自动调度，用 `resume-queue` 显式恢复；`occupancy_unverified` 需先核实旧执行已退出 |

### 10.2 执行相关

| 现象 | 处理 |
| --- | --- |
| 完全访问工具启动失败 | 检查 worker、Node 与安装依赖；完全访问无需执行账户或沙箱配置，服务 helper 的缺失只影响服务工具 |
| 受限任务立即失败 | 按[原生部署前置](../deploy/native/README.md)核实 bubblewrap/profile、user manager/bus、cgroup 委派与宿主工具；能力缺失明确拒绝、不静默回退 |
| 任务已结束但目录仍被占用，或报 `tool_process_unreaped` / `mode_switch_unverified` / `worker_stop_unverified` | 从任务事件与占用查询核对未退出的执行单元；确认旧单元及其后代已退出后，再用上方 `resume-queue` 恢复，它释放该会话遗留任务的父目录与副本占用，并重建已结束的驱动器。worktree 创建与汇总保留副本现场和已收到的结果，不能把已完成工具或效果未知操作自动重放 |
| 旧 local/container 覆盖被拒 | 移除 `--execution` / `RUUKOTO_EXECUTION_BACKEND` 覆盖或明确改为 native；保留原档案，先完成平台前置 |

### 10.3 MCP

| 现象 | 处理 |
| --- | --- |
| 认证失败（401/403） | 凭据无效、已撤销或权限不足——核对 `credentials list` 中 host／用途／scope 与 PAT 权限 |
| 服务不可用事件 | 按事件中的 reason 区分连接失败、超时、协议不兼容（SDK 结果校验失败说明服务端违反 MCP 规范）与工具数／分页超限 |
| 工具缺失 | `mcp check` 对比远端实际工具与允许列表；远端改名须更新配置（下一任务生效） |
| 限流（429）与超时 | 一次终止并明确报错，不自动重试；由拥有者决定重试时机 |
| `snapshot_missing` / `snapshot_corrupt` / `snapshot_changed` | 保留原目录、副本、私有基线和历史，核实来源身份及文件是否仍完整；该工作不能继续/交付，不回退 HEAD 或自动重跑，向拥有者报告后重新准备新工作 |
| `version_conflict` | 带有 `--expected-version` 的调用发现版本不符；重新读取当前版本后再保存 |

### 10.4 消息入口

| 现象 | 处理 |
| --- | --- |
| 消息没有触发任务 | 只接纳配置的拥有者、私聊、支持的文本或图片；其余只记 `<来源>.rejected`。核对 `qq status`／`telegram status` 的配置与在线状态 |
| 回复被跳过 | 目标与当前钉版不一致或入口停用，记 `<来源>.reply_skipped`，不改发；重新配置目标后新消息才生效 |
| 国内服务器连不上 Telegram | Node `fetch` 不读 `HTTP(S)_PROXY`；配置 `--api-base` 指向受控反代（必须 https）或走网络层代理 |
| 群消息被忽略 | 核心 QQ 群聊已退役，群消息直接忽略；旧群资料只读可查（`qq inbox`／`qq outbox`） |
| 审批命令无效 | 命令只作用于原平台、原账号、原配置版本；配置或凭据变化使旧审批失效，需重新申请 |

### 10.5 上下文与队列

| 现象 | 处理 |
| --- | --- |
| 任务以 `context_budget_exceeded` 中断 | 必留内容超过输入预算，任务中断并暂停队列；用 `/context` 查看分类估算，人工继续 |
| provider 返回 `context_overflow` | 任务中断并暂停队列，不自动压缩或重试；人工继续 |
| 模型配置无法应用 | `model_config_blocked`（有受影响任务）或 `model_config_busy`（正在应用）；等任务结束后重试 |
| 导入报 `revision_conflict` | 预览后源或目标发生变化，重新 preview 生成计划 |
| 回退被阻挡 | 导入后目标侧产生了新任务、事件、会话、授权或版本；返回 `ok: false`、`status: applied`，回执与资料保持原状 |

## 11. 已知限制

- 同一工作目录同时只允许一个写任务；并行修改靠 SubAgent 的 worktree，非 Git 目录串行。
- 上下文超出预算或 provider 返回 `context_overflow` 时任务中断、队列暂停，需人工继续。
- 原生任务使用实际后台账户的目录权限与宿主工具；HOME/TMPDIR 使用宿主临时磁盘，无单任务配额，停止未核实保留现场与占用。
- 服务器服务管理只覆盖白名单服务的检查与重启。
- 真实 QQ／Telegram 平台与 macOS 完全访问的正向路径缺少实测证据（目前均为模拟平台）；跨端共享记忆、邮件与 GitHub comment 渠道、独立的 QQ 群聊外挂尚未交付。逐项证据见[发布与验收说明](release-acceptance.md)。

## 12. 浏览器

两个产品的完全访问拥有者 main / 普通开发会话可直接调用 `browser` 打开网页、操作表单和看截图。其他模式、Plan、SubAgent、定时、工作流和 GitHub 评审不开放。先在运行后台的机器准备 [agent-browser v0.39.1 官方原生资产](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.1)及可运行的 Chromium；无需安装要求 Node ≥24 的 npm wrapper，宿主继续支持 Node 22.19/24。程序按官方 SHA-256 和版本核实；准备缺失只使浏览器不可用，模型任务不自动安装或提权。

```bash
RUUKOTO_BROWSER_BINARY=/absolute/path/agent-browser-darwin-arm64 \
RUUKOTO_BROWSER_CHROME="/absolute/path/Chromium" ruukoto server
# ruukoto-code server 使用同一组浏览器路径变量；各产品数据目录继续隔离
```

Linux 使用对应 linux 资产并准备系统库、可用 sandbox、持久磁盘空间；常驻服务将两个路径变量交给实际后台进程。默认 macOS 有头、Linux 无头。先让 Agent `start`，再打开登录页并 `pause`；按返回的 `dashboardUrl` 或有头窗口人工输入密码与验证码，密码不要发给 Agent。Linux 将该 URL 的端口经 `ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:<服务端端口> <主机>` 转发，只在本地打开。dashboard 只承担人工键鼠输入，不配置额外模型聊天。人工完成后发新消息让 Agent `resume`；原任务不能自行解除暂停。

接管已有浏览器先由拥有者启用本机 CDP，向 Agent 提供明确的 `http://127.0.0.1:<端口>` 或浏览器 WebSocket 地址并请求 `attach`。只接受 loopback，发现结果也重新核实地址和端口；同一目标跨产品、跨会话只允许一个自动化连接。`close`、取消或后台停止对附接仅断开自身连接，保留已有窗口和标签。不要把网络上的远程 CDP 地址交给该入口。

同一会话跨轮保留页面。默认空闲 60 分钟后回收，自有 profile、历史与截图保留；重新 `start` 只打开新页面，不恢复旧页面或重放点击/提交。持久 Cookie 与网站资料沿 Chromium profile 保存；没有到期时间的会话 Cookie 及网站自身的登录期限不保证跨关闭延续，必要时重新人工登录。

截图保存为不可变图片产物并交给视觉模型，用 `read-artifact <taskId> <artifactId> --output screenshot.png` 完整导出。纯文本模型在发送图片前明确报 `image_input_unsupported`；`image_too_large` 可改用视口截图；`artifact_write_failed` 检查磁盘与目录权限。动作报告 `outcome_unknown` 时先人工查看实际页面或服务端结果，再用新消息核实连接；不要重发原提交。`browser_stop_unverified` / `browser_identity_unverified` 先核对原进程及绑定，再显式 `close`；停止尚未核实前不会新开实例或释放接管占用。

## 桌面客户端

MyGo 试验运行 `npm run desktop:mygo`，或打开已构建的 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`；要求 macOS Apple Silicon，构建前提见[桌面开发](desktop-development.md#mygo-试验)。它沿用同一界面与后台，独立保存 Personal 配置和未决提交；切换外壳前先在原应用核实未知操作。MyGo 子进程失败时重新打开应用，Node 或仓库路径失效时重新构建。

在 macOS 运行 `npm run desktop:build` 后打开 `dist/mac-arm64/Ruukoto.app`。Code 可打开会话、提交输入、选择模型与会话默认模式、停止与继续任务、恢复暂停队列；日常应用采用登录 shell 的环境和日常 Code 档案，按需启动后台，退出应用后后台继续运行。开发入口与档案隔离见[开发说明](development.md#桌面客户端)。

左下设置可切换明暗主题；两侧边界支持拖动与方向键调宽，折叠后保留宽度。输入区加号选择本机附件，单会话草稿最多四个、每个最多 8 MiB；文件按选择时快照提交，不授予本机路径读取权限。普通文件交给 Agent 通过产物读取，JPEG、PNG、WebP 交给支持图片的模型；纯附件也可发送。核实期间原文与附件留在输入框，发送图标转为加载；接收确认后清空。长差异点击 more 续读，空文件显示空内容。

新增 Code 会话会继承当前或本次连接最近 Code 会话的模式、模型和 Effort；设置尚未保存或等待核实时，先核实再创建。模型菜单内可选择 Effort，模式和模型在窄输入区收为图标，底部按钮保持单排。Context 环形入口可查看最近一次已记录输入的三类估算，缺记录或容量时显示未知。执行时消息流末尾显示 Thinking 或 Working，Thinking下直接显示当前已记录reasoning，Working展开已完成与进行中的工具调用，reasoning位于组内首行；历史reasoning可折叠查看，现有记录最多保留8KiB尾部。Read 路径打开右栏预览，Edit／Write 展开差异，Bash 展开命令与结果，失败调用标红并显示错误。

右栏顶部加号可打开浏览器和当前工作区文件树；Git 工作区另有 Git graph，可展开提交详情；滚动接近底部自动加载更早提交，无总条数上限；提交主题和分支名保持自然宽度，可左右滚动。仓库变更时按提示刷新，追加失败保留已有内容并可重试。文件只读，支持文本、Markdown 预览／源码与常见图片；单文件上限 256 KiB，目录最多显示 200 项。文件夹行末加载图标消失后展开，空目录留空，读取失败可重试。打开的文件树每3秒及窗口聚焦更新展开目录，关闭停止；工作区外成功 Read 可查看已捕获的当时版本，源文件删除后仍可读，缺少捕获时明确提示。浏览器接受无账号密码的HTTP(S)网址与本机file地址；本机文档可加载同目录资源，敏感路径、越界和超预算会拒绝，具体范围见[桌面模块](modules/desktop.md)。只打开可信本地文档，其脚本及CDN依赖可读取或转交该目录的预览能力。站点若禁止嵌入则无法显示，不授予网页定位、设备或桌面控制权。

版本不一致时，界面显示连接错误并停止自动重试。客户端较旧需重建应用；受管开发后台较旧需重启开发启动器；日常后台较旧用 `lsof -nP -U` 查询当前控制 socket，核对唯一 PID、所属用户与完整命令，人工结束后点“重新连接”。多 PID 或无法核对时先检查控制目录配置与 spawn.log，不发送信号；未查到监听进程先确认查询命令执行成功。桌面应用不会替你停止后台进程。仓库移动或 node 不可用时按界面提示修复环境或重建。

Personal 的 SSH 连接层只支持[同账户部署](../deploy/systemd/README.md)：SSH 登录账户就是后台账户，且可访问控制目录、socket 与原 `owner.token`；只支持密钥或 ssh-agent 认证。建议在 `~/.ssh/config` 为桌面端单独配置不带 `LocalForward` 的主机别名，避免继承转发发生绑定冲突。令牌每次建连读取，本地不保存；账户或权限不符时按错误指引修正部署，不放宽令牌权限。左下设置的“PA 远程连接”保存主机别名与控制目录（默认 `/var/lib/ruukoto/control`）；工作区列表上方 Ruukoto 打开 PA 主会话，支持对话、附件和审批，右栏提供浏览器，也可从委派行打开SubAgent历史。远端与桌面端需使用相同控制协议，升级后重新连接。
