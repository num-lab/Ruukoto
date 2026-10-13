# Agent Note: 访问模式由技术边界实施，完全访问须拥有者显式选择

Status: implemented

原编号：ADR 0003

## 问题

拥有者要求对 Agent 的操作权限实施技术约束。模型能运行自由 Shell 及其子进程，所以靠提示词让模型自觉遵守、或只在 `git push`、`gh` 这类发布命令处拦截，挡不住越界的文件、网络和凭据访问。所有操作都逐项确认，又会妨碍工作区内的自主修改与验证；有些任务拥有者愿意放手让它直接使用账户权限。还有一层风险：任务执行权限一旦能读到拥有者的认证材料或改写宿主授权状态，就能冒充拥有者，给自己或其他任务提权，这时任何模式区分都没有意义。

## 决定

- **权限是技术约束。** 约束覆盖文件、命令、网络和凭据访问，不能只依赖模型遵守提示词，也不能只依赖专用发布工具的审批。
- **首期两种模式：请求确认（`confirm`）与完全访问（`full_access`）；自动审批后续加入。** 自动审批已由[自动审查模式](2026-09-22-auto-review-mode.md)加入为第三种 `auto-review`，它与请求确认共用同一受限执行环境，不扩大授权范围，也不升级为完全访问。访问模式类型为 `packages/core/src/types.ts` 的 `AccessMode = "confirm" | "full_access" | "auto-review"`。会话默认模式另有 `plan`，它不是第四种访问策略，任务固定采用 `auto-review`，见 [Plan 会话模式](2026-10-08-plan-session-mode.md)。
- **请求确认模式**：工作区内已授权的修改和验证自主执行；超出范围的操作（越界文件访问、未授权网络、凭据访问、外部写操作）形成具体的审批请求，等待确认后才执行。
- **完全访问模式**：拥有者明确选择的执行授权。任务可使用运行账户已有的权限，无需逐次确认；它不额外赋予系统权限。运行账户是专用执行账户，不是拥有者账户，见[工具工作进程与按任务容器](../architecture/2026-09-20-tool-worker-per-task-container.md)。
- **工程默认采用请求确认模式。** 新会话的默认模式是 `confirm`（`sessions.default_access_mode` 列缺省 `'confirm'`）。
- **模式绑定任务。** 有效模式和权限版本保存在任务上（`accessMode`、`permissionVersion`）；会话默认模式只决定之后新建且未显式指定模式的任务，更改它不改写既有任务。
- **模型、工具和群成员不能提升模式。** 只有经认证的拥有者能通过控制面的 `submit`、`continue`、`switch_mode` 与 `set_session_mode` 选择模式，模型没有切换模式或代为批准的工具。宿主自己创建的任务固定 `confirm`：入站事件（定时唤醒、Telegram 等外部来源）建的任务不继承会话默认的完全访问，见 [Telegram owner 入口](2026-09-24-telegram-owner-entry.md)；SubAgent 任务一律 `confirm`、不允许切换模式，也不继承父任务的完全访问，见[工作委托](../architecture/2026-10-03-work-delegation-subagent-task.md)与 [SubAgent worktree](../architecture/2026-10-04-subagent-worktrees.md)。
- **其他任务不继承临时授权。** 一次批准只放行对应的那次操作；继续中断任务创建的新任务不继承旧批准。
- **启用完全访问不放宽服务端对入口身份及会话访问的控制**：控制面照常要求拥有者认证，后台照常校验任务归属。但该执行账户可读的文件，不能再被宣称与这个完全访问任务隔离。
- **隔离机制在基础验证中选择，缺失时明确报错。** Linux 上请求确认任务在按任务建立的容器内执行，完全访问任务以专用执行账户运行，机制与平台范围见[工具工作进程与按任务容器](../architecture/2026-09-20-tool-worker-per-task-container.md)。提交与切换模式时检查所选模式的执行入口，不可用即以 `execution_unavailable` 拒绝，任务不创建；不把请求确认模式静默降为完全访问，也不回退到后台账户执行。
- **授权控制面与项目命令分别保护，完全访问也一样。** 完整的任务执行权限不能用于伪造拥有者身份，也不能用于提升其他任务的权限。若执行账户能直接改写宿主授权状态，该部署就不满足这一边界，需要用不同的系统身份或等效隔离调整，不能只凭应用内校验宣称已经隔离。具体做法见下节。

## 控制面拥有者认证

控制面分离靠拥有者令牌加上不同的系统身份实现，令牌认证从控制面协议 v2 起生效（当前协议版本 16）：

- 连接建立后，首个操作必须是 `auth`，携带拥有者令牌。认证成功前不返回快照，也不执行任何请求，一律以 `unauthorized` 拒绝。令牌比较用常数时间（`timingSafeEqual`）。
- 后台启动时确保控制面目录存在（以 0770 创建）。令牌文件 `owner.token` 缺失时生成：32 字节随机数的 hex，文件 0600，由后台身份持有；已存在则复用，拥有者客户端凭同一令牌认证。令牌至少 32 字符才有效。
- 令牌只经控制面目录的令牌文件或拥有者自己的环境变量传递，不出现在命令行、工具环境、日志或待确认记录中。客户端按以下顺序取令牌：`RUUKOTO_OWNER_TOKEN` → `RUUKOTO_OWNER_TOKEN_FILE` 指向的文件 → 控制面目录的 `owner.token`。后台只校验，不替客户端选择来源。
- socket `control.sock` 放在控制面目录（默认是数据目录的兄弟目录 `control/`），对拥有者开放连接；后台数据目录仍只对后台开放。
- 多用户 Linux 部署使用三个系统身份：拥有者使用可信 CLI/TUI，持有一份 0400、属主为拥有者的令牌副本；后台 `ruukoto-backend` 运行控制面，持有数据目录、模型凭据与令牌原件；执行账户 `ruukoto-exec` 运行完全访问任务，不属于拥有者或后台的组，读不到两者的认证材料。拥有者与后台共用同一 UID 的部署不满足控制面分离（`deploy/systemd/ruukoto-backend.service` 注释）：同 UID 下 socket 的文件权限区分不了拥有者终端和完全访问命令。
- 控制面目录、数据目录、agent 目录与服务代码目录是保护根。授权工作区和授予路径不能是保护根、不能落在保护根内，也不能是保护根的祖先（双向排除，`assertGrantNotProtected`）。
- 工具工作进程的环境不带 `RUUKOTO_*` 控制面变量；开发启动入口不继承日常实例的 `RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE`（`packages/tui/src/dev.ts`）。
- IM 平台身份不能代替令牌：QQ 号、Telegram 账号经平台入口提交的消息走入站事件，不能用来认证控制面。

## 模式切换

任务级切换只经拥有者的 `switch_mode`，不能进出 Plan。任务排队或等待审批时（没有执行中的工具）立即生效：先停止旧执行单元并核实已退出，再落库并递增权限版本、记录 `task.mode_switched` 事件；等待中的审批随之失效，后续操作重新判定，切到完全访问也不会自动执行旧的待批准操作。核实不了旧执行单元已退出时，任务以 `mode_switch_unverified` 中断并保留目录占用。任务运行中时登记待生效模式（`task.mode_switch_requested`），在下一个工具边界应用，执行中的调用继续使用开始时的范围。任务结束后拒绝切换。模式改变只作用于之后的操作，不追溯撤销已经产生的外部效果。

## 完全访问仍需审批的操作

「无需逐次确认」指执行账户已有的系统权限。以下授权独立于任务执行权限，完全访问照样逐次审批：

- 应用数据的破坏性变更，见 [main 应用数据空间](../architecture/2026-09-23-main-app-data-space.md)；
- 建立通知外发计划与一次外发，见[调度器与通知 outbox](../architecture/2026-09-24-scheduler-outbox.md)；新闻推送计划，见[定时新闻](../../archived/feature/2026-09-25-scheduled-news.md)；
- 服务操作：root 分支是后台经 sudoers 的提权能力，不属于执行账户权限，见[服务管理 helper](../architecture/2026-10-03-service-management-helper.md)；
- 结构化越界操作 `request_file_access` 与 `http_request` 不看模式、始终审批（完全访问下的编码工具本来就按执行账户权限读写，不必经过它们）。

代码里唯一按 `full_access` 跳过审批的是 MCP 写工具，见 [MCP 写工具审批](2026-09-23-mcp-write-tools-approval.md)。

## 备选方案

- **只靠提示词约束模型，或只拦截发布命令与专用发布工具** — 实现最省：不需要受限执行环境，拦住 `git push`、`gh` 这类命令就能挡住最常见的对外写操作。不选，是因为自由 Shell 及其子进程能绕开任何命令字符串匹配；只隐藏部分凭据也不等于阻止全部外部写操作。拥有者要求的是技术约束，所以执行环境本身要阻止越界访问，不依赖命令黑名单。（见 [personal-agent spec](../../../../.scratch/personal-agent/spec.md)「工程默认方案」与「权限模式与确认流程」，[personal-agent issue 03](../../../../.scratch/personal-agent/issues/03-tools-and-access.md)「实施范围」）
- **隔离能力缺失时把请求确认降为完全访问继续执行** — 在没有容器能力的宿主上也能用。不选，是因为拥有者会以为任务受限，实际却不受限；所以缺少后端、镜像或身份配置时明确失败，不自动退回完全访问。（见原决定第 3 段，personal-agent spec「权限模式与确认流程」，personal-agent issue 03「交付与验证」）
- **控制面只靠数据目录与 socket 的文件权限保护** — Unix socket 天然只允许能访问该路径的账户连接，不需要额外的认证协议；personal-agent issue 02 的运行时就是这样实现的。不选，是因为同 UID 下 socket 权限区分不了拥有者终端和完全访问命令，不能仅因使用 Unix socket 就宣称满足权限保证；改为拥有者令牌认证，并由不同系统身份保护令牌和授权状态。（见 [personal-agent issue 02](../../../../.scratch/personal-agent/issues/02-runtime.md) 实施计划与 Comments，personal-agent issue 03 实施计划 §1、§5）
- **完全访问任务以拥有者账户运行** — 完全访问能直接使用拥有者的全部文件与工具链，不用另配执行账户和工作区 ACL；拥有者账户与运行控制面的后台账户 UID 不同，内核也会拒绝它改写授权状态。不选，是因为这个账户同样能读到 CLI 的授权材料，可以冒充拥有者；改用与拥有者、后台都不同的专用执行账户，完全访问提供的是该账户已有的权限，不承诺读取拥有者账户的全部文件。（见 [阶段 0 基础验证结论](../../../../.scratch/personal-agent/foundation-findings.md)「控制面身份模型」，personal-agent issue 03 实施计划 §1；身份设计见[工具工作进程与按任务容器](../architecture/2026-09-20-tool-worker-per-task-container.md)）
- **首期就提供自动审批** — 能减少逐次确认对自主执行的打断。不选，是因为拥有者第 4 轮明确首期只做请求确认和完全访问；首期不引入模型判定审批或学习授权规则，范围内操作直接执行也不等于自动审批。自动审批之后以[自动审查模式](2026-09-22-auto-review-mode.md)加入。（见 personal-agent spec 第 4 轮确认与「权限模式与确认流程」，[personal-agent issue 12](../../../../.scratch/personal-agent/issues/12-session-mode-command.md)）

## 后果

- **收益**：拥有者可以在逐项控制与自主执行之间按任务选择，选择保存在任务上，事后可查。模型、入站消息、SubAgent 都改不了模式，越界操作的约束不依赖模型配合。完全访问任务也拿不到控制面身份，伪造不了拥有者，也提升不了其他任务的权限。
- **代价**：需要一个可验证的受限执行边界：容器镜像、执行账户、受保护的提权启动入口与工作区 ACL 都要维护，部署要分出三个系统身份。完全访问不提供执行账户内部的文件隔离，该账户可读的文件都可能被任务读取。
- **已知上限**：`local` 执行后端直接以当前账户运行工具，没有隔离，只用于开发与验证。个人 Agent `ruukoto` 的 CLI 默认仍是 `local`（生产部署以 `--execution container` 或 `RUUKOTO_EXECUTION_BACKEND=container` 显式启用），`ruukoto-code` 默认 `container`。`local` 生效时启动打印无隔离警告，握手的执行后端说明与 TUI 状态栏也会标出，不能据此宣称请求确认模式的边界已经生效。
- **何时重访**：某个部署里执行账户能改写宿主授权状态，或能读到拥有者令牌，就说明该部署不满足控制面分离，要先调整系统身份再声称满足；新增「完全访问也必须审批」的操作类别时，在对应笔记里写明它和本篇「无需逐次确认」语义的关系。

## 验证

- `test/10-access-modes.test.ts`：提交幂等比较包含模式与授权范围；`continue` 的新任务默认请求确认，拥有者可显式选择完全访问；`switch_mode` 在无执行中工具的边界生效、任务结束后拒绝；完全访问任务不逐次确认，也不改动其他任务的模式；缺少执行入口时完全访问明确失败；控制面认证前不返回快照、不执行请求；模型尝试调用 `switch_mode`、`respond_confirmation` 时模式和权限版本不变、没有批准记录；保护根双向排除。运行：`npx tsx --test test/10-access-modes.test.ts`。
- `test/40-qq-private.test.ts`：QQ 号不能代替控制面令牌，未认证连接不能响应审批。
- `verification/foundation/results/linux-isolation-report.md` 与 `linux-isolation-report-tx.md`：探针 `identity.task-uid-reads-backend-state`、`identity.task-uid-writes-backend-state` 证明任务 UID 读写后台持有的 0600 控制面状态被内核拒绝（EACCES）。
- tx 实测（[personal-agent issue 23](../../../../.scratch/personal-agent/issues/23-container-full-access.md) Comments）：完全访问任务以 `ruukoto-exec` 运行，读取拥有者令牌返回 `Permission denied`。这一条只能在真实的多身份 Linux 部署上证明，离线测试替代不了。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
