Status: resolved
Depends on: 04, 10, 11

# 重构交互入口与开发调试脚手架

## 目标与依赖

将日常交互、工作区新会话、配置管理和后台启动统一到清晰的命令入口，并提供隔离的开发实例，支持保存代码后重启后台或界面。复用现有 Runtime、控制协议和 TUI 组件，保持任务由后台持有。

本工单承接 [19 — 提供方与模型凭据配置管理](19-model-provider-management.md)，配置中心与模型配置能力统一在此实施，issue 19 不再单独实现。本工单不依赖 daily-agent 02/03 的业务能力；实施时须兼容它们对 Runtime、角色及工具清单的改动。

## 已确认交互

2026-09-23，用户通过 `/grill-me` 两轮确认 Q1–Q8，均接受建议。

| 命令 | 行为 |
| --- | --- |
| `ruukoto` | 打开现有任务 TUI，沿用默认会话选择，不隐式新建会话 |
| `ruukoto <路径>` | 以指定目录为工作区创建新 Session，并在任务 TUI 中进入它 |
| `ruukoto config` | 打开独立配置 TUI，支持在线管理及有限的离线初始化 |
| `ruukoto server` | 前台常驻运行后台；生产环境继续由 systemd 管理 |
| `npm run dev` | 启动隔离的开发后台，监听代码变化并重启相关进程 |
| `npm run dev -- --tui` | 开发后台加可重载的任务 TUI |
| `npm run dev -- --config` | 开发后台加可重载的配置 TUI；无模型时先完成离线配置 |

`npm dev` 不是 npm 支持的自定义脚本调用方式，文档和验收统一使用 `npm run dev`。`--tui` 与 `--config` 互斥，同时指定时在启动任何进程前报错。

### 1. 客户端与后台生命周期

- 普通 `ruukoto` 和在线配置中心只连接现有后台，后台未运行时提供启动指引，不自动拉起服务。普通任务 TUI 退出不停止后台或取消任务。
- `ruukoto server` 复用现有 `start` 的前台运行、单实例锁、信号处理和优雅停止能力，不实现额外 daemonize。服务启动失败返回非零退出码。
- dev 管理自己启动的整组进程。退出其任务/配置界面或按 Ctrl+C，统一停止后台、界面和监听进程；关闭终端也执行清理。同一开发实例已有后台时报错，不附加、重启或停止外部进程。
- “热重载”采用重启受影响进程。后台先优雅停止，活动任务保留中断事实，不自动重放模型或工具调用；队列和占用沿用现有恢复规则。只改界面代码时不重启后台。

### 2. 路径与项目、会话的对应

- 显式路径每次独立启动都创建新 Session；会话创建后，前端重载使用返回的 Session ID，不重复执行创建流程。
- 相对路径按客户端调用时工作目录解析，后台继续校验目录存在性、realpath、dev/ino、保护根和权限。只接受已有目录，不自动创建目录，不把文件当工作区；符号链接别名按相同目录身份处理。
- 按规范化目录查找已有开发会话对应的项目：只有一个项目时复用；多个项目时先选择；从未使用过的目录自动创建项目，再创建 Session。角色和 QQ 专用会话不作为普通工作区的自动归属依据。
- 自动项目名从目录名生成并处理重名，不能因为两个目录同名就合并项目。取消选择不创建会话；项目/会话创建失败不留下错误的选中状态或无效项目。
- 创建请求使用稳定的启动请求标识，覆盖接收成功但应答丢失后的查询与重试。现有 `create_session` 不幂等，不能直接在断线重试或 dev 重载时再次调用。标识仅在本次启动与重载中复用，下一次独立路径命令生成新标识。

### 3. 独立配置中心

首版在线配置覆盖项目指令/Web Search/资料授权、会话默认模型/思考档位/权限模式、MCP 配置、QQ 配置与允许群、服务凭据，以及 provider、模型目录、模型 API key 和后台默认模型。范围限已有能力和本次明确新增的模型配置；容器、systemd、执行账户部署参数继续使用现有方式。

- 配置中心使用独立入口和界面，复用现有 TUI 库、输入组件、认证连接及 Runtime 控制方法。任务执行审批仍在原任务 TUI，配置中心不成为绕过确认的新入口。
- 在线修改经拥有者认证控制面完成，前端不直接打开核心数据库或改写运行中后台的凭据文件。并发保存校验配置版本或文件修订，冲突时要求重新加载，不静默覆盖。
- provider 首版支持显式端点、SDK 已支持的协议、模型列表及必要的上下文/输出参数、API key。复用 SDK 的 `models.json`/`auth.json` 与公开配置能力；默认模型保存为最小的应用配置，显式启动参数优先。保留已有认证条目，不在本工单增加 OAuth 登录流程或自动模型发现。
- 模型 API key 与服务凭据分别管理，不能把 `auth.json` 与 `credentials.json` 混为一体。秘密输入遮蔽，响应只展示是否配置及必要元数据；秘密不进入日志、历史、事件、命令行参数或开发状态文件。
- 离线只负责模型目录、默认模型和 API key 的初始化与修复，其余选项提示连接后台；离线不直接修改项目、会话、MCP 或 QQ 数据库记录。
- 离线写入与后台使用配置期间遵守同一互斥规则，按规范化 `agentDir` 识别，覆盖不同 `dataDir` 指向同一配置目录的情况。socket 不可达或认证失败不能证明后台已停；无法取得独占或文件权限时明确失败，不自动改变目录属主或放宽权限。

### 4. 模型配置的应用规则

用户确认：provider、模型目录和 API key 只在没有受影响的运行及排队任务时应用；否则提示先完成或取消这些任务。其他项目/MCP/QQ 配置沿用已有生效规则。

- 检查覆盖 `running`、`awaiting_confirmation` 和 `queued`，并在检查到应用完成之间阻止新的受影响任务进入执行或队列。被占用时不先改 `auth.json`、不部分应用，也不自动取消任务。
- 当前 `ModelSelection` 只保存 provider/model ID/思考档位，没有保存 URL、协议、密钥或完整模型定义。issue 19 旧计划中“旧任务保留完整配置快照”的假设不成立；本工单通过应用时机约束实现确定行为，不建设多代运行时共存。
- 应用成功后，持久配置、ModelRuntime、ModelCatalog、相关 Driver/Reviewer 和已有 SDK 会话使用一致的新配置。不能仅调用 `refresh()`，也不能只以 `setRuntimeApiKey()` 的内存覆盖冒充持久保存。
- 保存前校验结构、模型预算与凭据格式；网络连通性测试作为显式操作，不把本地校验描述为模型服务已可用。文件写入或内存刷新失败时返回明确结果并保持可恢复状态，重启后不能静默选用部分新配置。
- 删除 provider/模型前核实后台默认、会话与 `agent_roles.modelSelection` 引用，先提供可用替代项，避免悬空配置。新的后台默认模型用于后续新会话，既有会话的显式选择不被批量改写；未显式选模型的角色继续按已有规则在后续任务中使用后台默认。中断任务后来由拥有者继续时重新校验当前配置，不自动恢复已经删除的凭据。

### 5. 隔离开发实例与重载

- dev 使用稳定且可复用的独立 profile，保留开发历史。profile 放在 `CODE_ROOT` 外的用户私有目录，按仓库身份区分；data/agent/control 分为子目录，使现有 `dirname(dataDir)/agent-work` 不落入保护根。不能放在本仓库 `.scratch/dev`，也不能为 dev 放宽保护根检查。数据、应用配置/凭据、控制 socket/owner token、待确认提交及日志均与日常实例分开；至少覆盖 DATA_DIR、AGENT_DIR、CONTROL_DIR、PENDING_DIR 的解析，不能只改数据库目录。
- 不自动继承生产 owner token、受保护执行账户配置或消息平台凭据。真实 QQ/Telegram 等渠道默认停用，每次 dev 启动都保持这一边界；真实模型须显式配置。允许显式导入模型配置到开发目录，不共享可写的生产 agentDir。
- `dev --config` 缺少有效模型时先打开离线配置；保存有效配置并释放配置锁后启动开发后台，再切换为在线配置。放弃或保存失败不启动后台。`dev` 和 `dev --tui` 缺配置时提示使用 `dev --config`，不回退到其他模型。
- 监听范围区分后台、任务 TUI、配置 TUI 与共享模块；配置文件、数据库、会话记录、产物、日志和重载状态不纳入源码监听，避免自身写入触发重启循环。连续变更合并处理，旧进程退出并释放锁后才启动替代进程。
- 同一终端只有当前前端读取 stdin 和控制 raw mode/屏幕。后台日志另写开发日志文件，监听器诊断不覆盖界面。已安装的 `tsx watch` 会读取 stdin、清屏并在超时后强杀，不能未经协调直接包在交互 TUI 外层。
- 任务 TUI 重载至少恢复数据实例、当前 Session、未提交草稿和对应的“继续任务”意图；历史与任务状态从后台读取。重载不自动提交草稿或重复创建 Session。只在当前 dev 启动中使用恢复记录，新的一次独立命令遵循正常入口规则。
- 复用 `PendingRequestStore` 的原子落盘与实例核对方式，但界面状态单独保存，不能伪装成待提交任务。普通草稿写受保护文件；API key 等秘密表单值不落入重载文件，重载后重新输入。恢复记录无效时给出提示，不把继续任务草稿静默改为新任务提交。
- 退出、重载失败和可处理异常都恢复终端，清理本次拥有的子进程；不能只停止外层 watcher 而留下占锁后台。普通 TUI 的退出语义仍符合 [ADR 0002](../../../docs/adr/0002-detach-terminal-from-task-runtime.md)。

## 实施顺序

以下为落实已确认需求的工程方案，实施时核对最新代码；创建工单不代表实现已经完成。

1. 调整 `src/cli.ts` 分发与参数解析，增加默认 TUI、路径、config 和 server 入口，复用现有函数。优先用 `node:util` 参数解析，不新增 CLI 框架。命令名优先，名为 `config/server/status` 的目录用 `./config` 等显式路径或 `-- <路径>` 打开；处理布尔参数、空格路径、未知参数与非 TTY。补齐实际可执行的 `ruukoto` 安装入口，不能只在帮助中声明命令。
2. 接通路径创建和启动请求核实，复用 `createSession` 的目录身份/保护根检查与 TUI 创建后切换逻辑，不新增另一套权限模型。默认入口、`--session`、演示入口和 `/new` 的原有能力按新命令层级继续可用。
3. 先完成配置读取、模型持久化、应用时机和配置独占，再接独立配置 TUI。复用控制 API 与 SDK 存储/文件锁；配置应用失败、后台启动失败和锁释放共用可验证的收尾路径，支持在线/离线切换。
4. 增加开发启动脚本及 `package.json` 的 `dev` 脚本，复用已安装 tsx 执行 TypeScript，以 Node 现有进程/监听能力管理后台和所选前端。实现 profile 隔离、就绪检测、信号转发、重载边界与界面状态恢复，不增加通用进程管理框架。
5. 更新 CLI/TUI 帮助、README、`docs/runtime.md`、systemd 示例和测试入口。`ruukoto tui` 被无参入口替代，旧拼法给出迁移指引；`start` 暂保留到同一后台实现的兼容别名，文档推荐 `server`。其他管理 CLI 继续用于脚本和非 TTY 环境。
6. 交付时追加实际命令、配置位置及生效规则、迁移说明、测试结果和真实环境未验证项，再更新工单状态。

## 验收标准

- 默认 `ruukoto` 打开会话选择，无后台时不创建后台；`server` 前台运行并响应退出信号；systemd 示例及非 TTY 管理命令有效。
- 路径入口覆盖单项目复用、多项目选择、全新目录、同名不同目录、符号链接、空格路径及命令同名目录。每次独立调用创建一个新 Session，重连/应答丢失核实与前端重载不多建；非法或受保护目录不留下无效项目/会话。
- 配置 TUI 可管理全部已确认对象；首次无模型可离线配置，后台存在或同 agentDir 被占用时不能离线写入。不同 dataDir 共用 agentDir、不同账户无权限及并发保存冲突均不绕过约束。
- 受影响 running/awaiting_confirmation/queued 任务阻止模型配置应用，检查期间的新任务不能钻过边界。空闲应用后目录、认证、SDK 会话与审查模型一致，API key 重启后仍有效；失败或无效配置不覆盖原可用配置，秘密不出现在日志、事件或重载文件。
- 干净开发目录的 `npm run dev -- --config` 能完成“离线初始化 → 后台启动 → 在线配置”；另外两种 dev 命令缺配置时明确提示。开发 profile 与验收工作区使用代码目录外的位置，角色工作区通过原有保护根校验。标志冲突、已有开发后台、启动失败均无残留进程。
- 后台代码变更导致优雅重启及任务中断记录；任务 TUI 独立重载保留会话、草稿和继续意图，后台任务继续运行。配置 TUI 也能重载，共享代码按影响范围重启；不重复提交任务，不因日志/数据库写入循环重启。
- 用现有 PTY 设施验证输入、绘制和日志不串写，重载失败/退出后恢复终端。dev 退出清理自有进程，普通 TUI 退出保留后台；日常数据、凭据、待确认提交和消息渠道不受 dev 影响。

复用模型选择、控制协议、TUI、PTY 和崩溃恢复测试设施，增加必要的入口、配置应用和开发进程用例，不编写仅重复实现的测试。执行定向检查及 `npm run typecheck`，收尾运行一次 `npm test`；涉及 Linux 执行账户或 systemd 的验证可使用 `ssh tx`，区分模拟、PTY 与真实部署结果。

## Comments

### 2026-09-23：需求访谈完成并创建工单

用户提出交互入口重构、独立配置中心与开发热重载，先后确认 Q1–Q5、Q6–Q8 全部推荐行为。已核对 CLI/TUI 生命周期、项目与工作区关系、配置能力、SDK 模型缓存/认证、实例锁和开发终端限制。配置管理合并自 issue 19；本次仅创建规格与实施任务，未修改应用代码或执行实现测试。

### 2026-09-24：交付（c094143）

全部六个实施步骤完成，`npm run typecheck` 干净，`npm test` 344 通过 / 0 失败 / 1 跳过（06 需 RUN_MODEL_CHECK=1）。

**实际命令**

- `ruukoto`（无参）打开任务界面（沿用默认会话选择，不隐式新建）；`ruukoto --session <id>` / `--demo` 对应原 `tui` 参数。`ruukoto tui` 旧拼法打印迁移指引后仍可用。
- `ruukoto <路径>` 以该目录为工作区创建新会话并进入；`./config`、`-- <路径>` 打开与命令同名的目录。命令名优先于路径；布尔参数经 `node:util` 严格解析（不再吞下一个 token）；未知参数与非 TTY 明确报错。`bin/ruukoto.mjs`（package.json `bin`）提供实际可执行入口（`npm link` 后可用）。
- `ruukoto config [--offline]` 打开配置中心；后台不可达时提示后进入离线模式，同一 agentDir 被占用（配置锁）时拒绝写入。
- `ruukoto server` 前台运行后台（复用原 `start` 全部能力并补读 `RUUKOTO_CONTROL_DIR`）；`start` 保留为兼容别名，文档与 systemd 示例已推荐 `server`。
- `npm run dev [-- --tui | --config] [--import-models <目录>]`：隔离开发实例；`--tui` 与 `--config` 互斥且在启动任何进程前报错。

**配置位置及生效规则**

- 模型配置在 `<agentDir>`：`models.json`（provider/模型目录）、`auth.json`（API key）、`default-model.json`（后台默认模型，显式 `--model` 启动参数优先）、`config.lock/`（配置独占锁，后台运行期间持有，不同 dataDir 共用 agentDir 也互斥）。全部原子写入、0600。
- 在线保存经 `expected_revision`（三文件内容指纹）条件更新；provider/目录/API key 仅在没有受影响的 running/awaiting_confirmation/queued 任务时应用（`model_config_blocked`），检查到应用完成之间受影响 provider 的新提交与 set_session_model 被拒绝（`model_config_busy`）。应用=校验→原子写→重建 ModelRuntime/目录/审查器并同步存活 Driver（SDK 会话在下一任务边界重建），失败回滚文件。删除 provider/模型前核实后台默认、会话与 agent_roles 引用（`provider_in_use`，经目录保存删除同样约束）。`test_model_connection` 为显式网络探测。
- 开发实例 profile：`~/.ruukoto-dev/<仓库名>-<路径哈希>/{data,agent,control,pending,logs}`；环境清洗（剥离生产 owner token/执行账户/消息平台变量），QQ 默认停用（`RUUKOTO_DISABLE_QQ=1`）。界面重载状态在 `<profile>/reload-state.json`（0600，按实例标识核实，秘密不落盘）。

**迁移说明**

- `ruukoto tui [--session id] [--demo]` → 无参 `ruukoto`、`ruukoto --session`、`ruukoto --demo`；`ruukoto start` → `ruukoto server`（别名继续有效，systemd 单元无需变更）。
- 既有 `models.json`/`auth.json` 原样沿用；后台默认模型首次保存后写入 `default-model.json`。schema v12 自动迁移（新增 create_request_id 列）。

**测试结果**

- 新增 47 个用例：test/29（入口分发）、30（工作区入口与创建幂等）、31（模型配置应用/门闩/锁/回滚）、32（dev profile/环境清洗/重载恢复/PTY 生命周期）、33（配置中心在线/离线/遮蔽/冲突）。全量 344 通过；另做了 `dev --config` 非 TTY 冒烟（离线初始化→放弃不启动后台，无残留进程）。
- 评审（Standards/Spec 双轴）后修复：save_model_catalog 删除绕过引用检查、reload-state.ts 监听误分类、set_session_model 门闩缺口、思考档位/目录解析重复代码。

**真实环境未验证项**

- Linux 执行账户与 systemd 实机（可用 `ssh tx` 复核）：本次仅验证 unit 文件命令拼写与既有测试；container 后端在 macOS 未实测。
- 真实 QQ/Telegram 渠道与真实模型端点（mock 覆盖；`test_model_connection` 逻辑经 MockModelServer 验证）。
- `dev --config` 的 PTY 级全流程（离线→保存→在线切换）未做端到端 PTY 验证（各环节分别经 test/32、33 覆盖）。
- 既有问题（与本工单无关，未处理）：test/26-qq 的 TTL 用例在高负载下偶发失败（main 上可复现）；仓库根 `undefined/` 目录为 9-21 遗留运行时数据。

### 2026-09-24：提交 c094143 评审与分批修复

评审范围为 c094143 相对其父提交的改动，共 15 项问题，分四批处理：

- **第一批：秘密与配置保存**：① `test_model_connection` 把服务端错误报成连接成功；② MaskedInput 丢弃括号粘贴，粘贴的 API key 被整段丢掉；④ 应用失败时先回滚再脱敏，新写入的秘密不会被脱敏；⑤ `sanitizeCatalog` 不遮蔽 headers 值；⑥ 内联 apiKey 且 auth.json 无条目时，脱敏占位回写导致所有目录保存失败。
- **第二批：启动参数与持久默认的优先级**：③ cli 总是传 `--thinking off`，使持久默认思考档位失效；⑩ `--model` 启动后在线设置默认模型立即生效，重建后又被静默改回。
- **第三批：并发与恢复**：⑦ 工作区入口请求超时后进入 awaiting-reconnect，但连接未断，永远等不到快照；⑧ `setSessionModel` 在门闩检查与写入之间 await，与删除 provider 竞态，留下悬空引用；⑨ 内部提交（父会话唤醒、入站事件）遇 `model_config_busy` 不重试。
- **第四批：dev 与收尾**：⑪ dev 仅重启后台时配置中心断开且不重连，`model-config.ts` 归类有误；⑫ 重载恢复时屏幕 id 与菜单项 value 不一致；⑬ `configRevision` 拼接字节无文件名和长度分隔；⑭ `findWorkspaceProjects` 未排除角色会话；⑮ `probeModelConfig` 与 Runtime 的默认模型解析不一致。

#### 第一批修复

1. **连接探测**：`completeSimple` 不以 reject 报错，改为检查 `stopReason`，`error`/`aborted` 报失败，失败详情脱敏。
2. **粘贴**：MaskedInput 识别整段 `\x1b[200~…\x1b[201~` 并剥离标记；其余转义序列照旧忽略，控制字符照旧过滤。
3. **回滚脱敏**：先按失败时的文件脱敏再回滚。脱敏范围从受影响 provider 扩大到配置文件中的全部秘密（`configSecrets`：auth.json 的 key，以及目录中的 apiKey 和 headers 值），覆盖新增 provider。
4. **headers 遮蔽**：秘密位置统一为 apiKey 与 headers 的每个值（provider 级和模型级），`sanitizeCatalog` 一律替换为 true。配置中心编辑头时显示 `k=***`，保留 `***` 即沿用原值。
5. **占位回写**：新增 `restoreCatalogSecrets`，在线 `save_model_catalog` 与离线保存在校验前把占位 true 还原为原值（数组元素按 id 对齐，找不到时按下标）。无原值可还原的占位仍被校验拒绝，校验同时覆盖模型级 headers。配置中心删除 `catalogPayload` 特例，改为 `structuredClone` 整份回写，缓存视图不再被编辑改动。

回归测试：test/31 增加 headers（含模型级）脱敏、脱敏视图原样回写保留内联 key 与 headers、无原值占位被拒绝、服务端 500 时探测报失败、新增 provider 的秘密在回滚错误中被脱敏；test/33 的 API key 用例改为粘贴加逐字输入。改动前这些新断言全部失败。`npm run typecheck` 通过；`npm test` 368 项，367 通过，1 项按默认跳过。

#### 第二批修复

规则统一为：生效默认只由 `resolveConfiguredModel` 一处决定，启动、重建和在线设置默认都走它；显式 `--model`/`--thinking` 始终优先于 `default-model.json`。

1. **③ 思考档位**：`server` 未指定 `--thinking` 时不再传 `off`，持久默认的档位得以生效。`modelInfo()`（任务界面展示的默认模型）原先也读启动参数，改为取生效默认的档位。
2. **⑩ `--model` 优先级**：`resolveConfiguredModel` 改为同步函数，`setDefaultModel` 写文件后用它重新解析运行时默认。带显式参数运行期间，在线设置只写文件，运行时默认保持不变，不会等到重建才翻转。
3. 文档：`docs/runtime.md` 补充默认模型与思考档位的来源和优先级。

回归测试：test/31 的 set_default_model 用例增加两条断言：重启后界面展示持久默认的档位；显式参数运行期间在线设置默认后，运行时默认仍取显式参数。两条在旧代码上均失败。`npm run typecheck` 通过；`npm test` 368 项，367 通过，1 项按默认跳过。
