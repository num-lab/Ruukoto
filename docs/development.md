# 开发与验证

在完整仓库根目录运行：npm workspaces 包含 `packages/*` 与 `apps/*`，共用根锁文件；`verification/foundation/` 保持独立包和锁文件。应用复用基础验证，基础验证也引用根目录的测试助手；测试与助手集中保留在根 `test/`。

```bash
npm run setup
npm run check
```

`setup` 检查 macOS / Linux、普通用户账户、Node ≥ 22.19、Git、Bash、Python 3 与 PTY 能力，然后对根目录和 `verification/foundation/` 执行 `npm ci`，安装受 Git 管理的 pre-commit 钩子。首次安装需网络；`check` 使用本地 mock 模型和临时数据，不需要模型凭据、Docker、真实 IM 或系统服务。Python 3 的 PTY 检查保证终端用例实际执行。依赖有变更时更新对应的 `package.json` 与 `package-lock.json`，重新运行 `setup`。

macOS 构建原生监督器另需 Command Line Tools 的 Clang。平台前置、真实证据与复跑命令见[原生边界验证](../verification/foundation/scripts/native-isolation/README.md)；离线 local 测试不证明 OS 边界。

## 跨模型协作

给新会话一个工单路径和角色，例如「以审查者身份接手这张工单」。[开发流程](../.agents/skills/development-workflow/SKILL.md)定义交接和验收；角色与模型可分别选择，工程验收与产品验收分别记录。

## 日常反馈

| 根目录命令 | 检查范围与产物 |
| --- | --- |
| `npm run build` | 构建原生监督器、工具与脚本 worker 及 WASM，再生成两产品的 `dist/*.tgz`；无需 Docker，应用通过 tsx 运行源码 |
| `npm run build:script` | 打包 `worker/workflow-script.mjs` 并复制同目录 WASM；脚本测试前运行 |
| `npm run lint` | 检查正确性与关键约定，不统一全库排版 |
| `npm run typecheck` | 根测试与脚本、每个 workspace 包、基础验证各自执行静态类型检查 |
| `npm test` | 应用与基础验证的全部离线测试；真实模型用例按默认开关跳过 |
| `npm run check:static` | 依次执行 lint、类型检查、笔记门禁与文档门禁（链接、源码引用、篇幅与段落形态） |
| `npm run check` | 依次执行环境检查、build、`check:static` 与全部离线测试，任一步失败即停止 |
| `npm run test:app` | 仅应用离线测试 |
| `npm run test:foundation` | 仅基础验证离线测试 |
| `npm run change-scope -- --base <ref>` | 报告本次改动相对 merge base 的已提交、暂存、未暂存与未跟踪路径 |

修改过程中运行 `npm run check:static` 与相关测试。**不要默认跑全量 `npm run check`**：按改动面选最小检查集，见 [提交前检查](../.agents/skills/pre-push-checks/SKILL.md)；全量只在拥有者明确要求、诊断 CI 失败或改动确实横跨全仓时跑。定向测试使用明确文件名，例如：

```bash
npx tsx --test test/71-product-entry.test.ts test/32-dev.test.ts
npx tsx --test verification/foundation/test/03-tools.test.ts
```

测试集中保留目录与编号；按功能词找覆盖分支，跨模块再查调用者。下表列起点，完整列表用 `rg --files test`。

| 修改位置 | 常用测试起点 |
| --- | --- |
| `packages/tui/src/cli-entry.ts`、`packages/core/src/product.ts`、`packages/tui/src/dev.ts`、`apps/ruukoto-code/src/dev.ts` | `test/29-cli-entry.test.ts`、`test/32-dev.test.ts`、`test/71-product-entry.test.ts` |
| `packages/runtime/src/` 与 `packages/control/src/` 的任务生命周期 | `test/01-concurrency.test.ts` 至 `test/05-overflow-db.test.ts`、`test/66-control-seam.test.ts`、`test/94-task-ending.test.ts` |
| `packages/agent/src/` 的执行、审批与权限 | `test/07-real-tools.test.ts`、`test/08-approvals.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts` |
| `packages/agent/src/script-worker/` | `test/104-workflow-script.test.ts`、`test/100-worker-stop.test.ts` |
| 工作流存储、协调器与宿主操作 | `test/105-workflow-runtime.test.ts` 至 `test/109-workflow-cold-recovery.test.ts`、`test/110-workflow-workcopy.test.ts`、`test/111-workflow-capabilities.test.ts`、`test/112-workflow-real-steps.test.ts`、`test/113-workflow-source-capabilities.test.ts` |
| `packages/agent/src/` 的上下文与模型 | `test/18-model-selection.test.ts`、`test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`、`test/98-media-model-pinning.test.ts` |
| SubAgent、worktree 与导入 | `test/80-subagent-delegation.test.ts` 至 `test/87-retire-coding-role.test.ts`、`test/91-release-acceptance.test.ts`、`test/95-work-copy.test.ts` |
| `packages/tui/src/tui/`、`packages/tui/src/config-tui/` | `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/33-config-tui.test.ts` |
| `packages/channels/src/qq/`、`packages/channels/src/telegram/`、`packages/channels/src/scheduler/` | `test/26-qq.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/38-telegram-owner.test.ts`、`test/40-qq-private.test.ts`、`test/89-im-entries.test.ts` |

失败保留用例名、断言和环境，区分回归与前提；独立复现后修复，默认检查和 CI 不自动重试。[发布验收](release-acceptance.md)的历史结果不证明当前代码通过。

代码里的待办标记按紧急度分三种，便于检索时排序：`FIXME` 是发布阻断项，`TODO` 是应尽快处理项，`XXX` 是将来再说的项。三者都写明要做什么，不只留一个标记。

## 提交与 CI

pre-commit 依次执行暂存内容的行尾检查与 `npm run check:static`：`git diff --cached --check` 拦行尾空白与文件末尾空行，`scripts/check-staged-eol.mjs` 拦末尾缺换行或多出空行。完整离线检查由 `check` 与 CI 执行。安装时检查已有 `core.hooksPath` 和 pre-commit 配置，遇到冲突会在安装依赖前停止，保留原钩子。若沿用自定义钩子，先将 `npm run check:static` 接入原配置，再运行 `npm run setup -- --skip-hooks` 安装依赖；若使用仓库钩子，先备份并移走原配置，再运行默认 `setup`。已有钩子的来源可用 `git config --show-origin --get core.hooksPath` 核对。已有 `core.hooksPath` 指向当前仓库的 `.githooks/` 时，`setup` 检查入口可执行后直接复用。

未配置 `core.hooksPath` 时，Git worktree 共用钩子目录，`setup` 在其中安装固定转发脚本，每次提交执行当前检出的 `.githooks/pre-commit`。主检出与 linked worktree 均可安装并复用转发脚本，切换分支或删除其他 worktree 不改变本检出的检查入口。旧检出没有仓库钩子或 `check:static` 时明确提示跳过；这种兼容不代表旧分支已验证，需要按该版本的开发说明单独检查。

GitHub Actions 在 macOS / Linux × Node 22.19 / 24.15 四组环境执行 `npm run setup -- --skip-hooks` 与 `npm run check`；CI 直接执行检查，不安装提交钩子。最低版本覆盖支持边界，Node 24.15 覆盖本次约定的开发版本；环境缺少 Python 或 PTY 能力时失败，不通过跳过终端用例取得绿色结果。提交钩子和 CI 使用相同的根目录命令。

`worker/` 由构建生成，QuickJS core 与 release-sync WASM 由 agent 包锁版；`node_modules/` 由锁文件安装。数据库、令牌和凭据留在产品档案，不入工作树；测试用临时档案。开发实例的隔离与执行后端见 [README](../README.md#开发本项目)。

## 外部验收

| 根目录命令 | 所需环境与覆盖 |
| --- | --- |
| `npm run linux:probes` | Linux 原生前置；bubblewrap、namespace、seccomp 与 user scope 边界探针 |
| `npm run test:native` | Linux、已构建 worker 与原生前置；个人工具、协作、恢复、原 IM 汇报与定时委派，模型与消息平台为桩 |
| `npm run test:upgrade` | Git、依赖安装网络与基线版本；smoke-24 的 `--upgrade-only` 路径，使用 mock 模型 |
| `npm run test:model` | `~/.pi/agent/` 的模型配置与凭据；按 provider 尝试短往返，首次成功后停止 |
| `npm run test:release-model` | 已构建的原生执行入口、Python PTY 与显式模型配置；smoke-24 的真实模型编码、TUI 退出后继续与重连 |

原生边界按[平台脚本](../verification/foundation/scripts/native-isolation/README.md)单独验收；缺能力或对照时返回不可验证；离线用例不替代真实 OS 证据。

具体脚本、参数、退出码和清理行为见 [smoke 运行说明](../verification/smoke/README.md)。真实模型编码验收使用 `npm run test:release-model -- --models /path/to/models.json --model provider/model`；模型配置可以包含凭据，应使用工作树外的受保护文件。升级默认基点与旧产品名称的边界见[发布验收的复跑说明](release-acceptance.md#当前复跑入口)。真实模型编码入口在启动 TUI 前，按实际子进程的环境检查所选模型的配置、认证、思考档位与预算；此检查不调用模型。配置需能独立提供认证，不继承模型 API key 环境变量，也不读取个人或相邻的 `auth.json`；仅有请求头不能证明认证可用。前提不满足时退出 2。`test:model` 缺少配置时提示跳过，这种结果不计为真实模型验证通过。真实模型编码与安装升级是独立检查，需要分别执行。外部验收与离线检查分别执行：历史 Docker 结果不替代原生 Linux 的权限验证，模拟平台也不代表真实 QQ / Telegram 已验收。旧 systemd / sudo 脚本保存在[特权脚本归档](../verification/archive/README.md)，其系统写入需要隔离改造后再提供运行入口。当前发布证据与仍需人工完成的项目见 [发布验收](release-acceptance.md)。

## 开发实例

`npm run dev` 启动 ruukoto 开发后台，`npm run code` 启动 ruukoto-code 开发后台并默认打开 TUI。

```bash
npm run dev                                            # ruukoto 开发后台，源码变更自动重启
npm run dev -- --config                                # ruukoto 开发实例的配置中心
npm run code                                           # ruukoto-code 开发后台并打开 TUI
npm run code -- ../my-project                          # 以该目录创建/复用工作区，并进入新会话
npm run code -- --config                               # ruukoto-code 开发实例的配置中心
npm run code -- --import-models ~/.ruukoto-code/agent  # 只复制模型配置
```

`dev` 继续使用 `~/.ruukoto-dev/<仓库>-<哈希>/`，`code` 使用 `~/.ruukoto-code-dev/<仓库>-<哈希>/`，下有 `data/agent/control/pending/logs`，稳定复用、保留各自开发历史，位于代码目录外。新 code 档案不自动迁入现有 dev 历史，两个开发档案与日常产品档案的锁和控制面分开。两个入口都支持 `--import-models <目录>`，只复制 `models.json` 与 `auth.json`，不复制服务凭据和默认模型文件；首次运行可先用对应的 `--config` 配置模型。

- **工作区入口**：`npm run code -- <路径>` 路径参数只接受一个已存在的目录，按真实目录身份创建或复用工作区并进入新会话；不新建目标目录。相对路径按 npm 脚本的当前目录（通常为本仓库）解析，路径含空格时加引号，目录与 CLI 命令同名也可使用。路径不能与 `--config` 同用，`dev` 不接受路径；目录身份与保护根校验沿用日常工作区入口，代码仓库本身不能用作工作区。路径只传给首次 TUI 启动，源码重载后恢复原会话、草稿与继续意图，不再次创建会话。
- **环境清洗**：子进程先清除两产品目录变量、生产 owner token、服务配置与外部产品身份，再按 profile 显式注入 `RUUKOTO_PRODUCT` 与本产品的 `*_DIR`；固定注入 `RUUKOTO_DISABLE_QQ=1` 与 `RUUKOTO_DISABLE_TELEGRAM=1`，每次启动生效。
- **执行后端**：沿用产品默认值，`dev` 与 `code` 均为 `native`，受限任务无需 Docker；原生能力缺失时明确失败，开发入口不继承生产执行覆盖与完全访问账户配置。
- **进程与重载**：两个启动器管理自己启动的整组进程；退出界面或 Ctrl+C、关闭终端都统一清理后台／界面／监听。同一开发实例已有后台时报错，不附加或停止外部进程。监听仅限 `packages/*/src/` 与 `apps/*/src/` 源码：后台代码变更优雅重启后台（活动任务保留中断事实，不自动重放），任务界面自动重连，配置界面不重连、随后台一并重载并恢复所在分区；只改任务／配置界面代码时不重启后台；共享模块变更两者都重启。连续变更合并处理，旧进程退出并释放锁后才启动替代进程。修改共享启动器 `packages/tui/src/dev.ts` 或 `apps/*/src/dev.ts` 时提示手动重启当前 npm 命令。
- **界面状态恢复**：code 启动的任务界面把当前会话、未提交草稿与继续任务意图原子保存到 profile 的重载状态文件（0600；秘密表单值不写入，重载后重新输入）；重载后按数据实例标识核实恢复，记录无效时给出提示并按正常入口继续，不把继续任务草稿静默改为新任务提交。该记录只在本次启动内使用。
- **日志与终端**：后台日志写 `<profile>/logs/backend.log`，监听诊断写 `dev.log`（无界面时打印到终端），不与界面输入／绘制串写。
- **配置引导**：对应入口的 `--config` 缺少有效模型时先打开离线配置界面；保存有效配置并释放配置锁后启动开发后台，再切换为在线配置；放弃或保存失败不启动后台。配置中心退出后结束本次开发启动。

## 耗时基线与后续批次

本节记录 2026-10-09 那一批的实测，用于选择日常反馈方式；当前 workspace 布局的实测见[同仓 workspaces 分包](../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)。改造前基线对应 `36c55dbe06d8e55e3ec52687c39dfab0d5762181`。本机使用 macOS、Node 24.15.0；Linux 使用 `ssh tx` 上不含本地 scratch 的独立检出。下列为墙钟耗时，历史命令的覆盖范围按该版本记录，不能当作当前 `check` 的通过结果。

| 环境与 Node | 基线命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| macOS，24.15.0 | 旧 `npm test`（应用） | 1009 通过、1 跳过、0 失败 | 167.32 s |
| macOS，24.15.0 | `npm --prefix verification/foundation test` | 9 通过、1 跳过、0 失败 | 2.08 s |
| Linux，24.21.0 | 旧 `npm test`（应用） | 1007 通过、1 跳过、2 失败 | 495.22 s |
| Linux，24.21.0 | `npm --prefix verification/foundation test` | 9 通过、1 跳过、0 失败 | 7.06 s |

Linux 基线的两个失败都来自 `test/67-visual-docs.test.ts`：源码锚点和链接引用了未纳入 Git 的本地 scratch 文件，独立检出缺少它们。该批次将关键脚本与归档纳入 Git，并把图解来源改为可获取的文件，以修复这一环境依赖。

该批次最后通过的实测如下，均使用完整隔离检出和锁定依赖。两次 macOS 完整检查分别使用 Node 22.19 与 24.15，后者复用同一检出已安装的依赖。该批次结束时四组矩阵刚配置完成、尚未触发远端运行；本地结果不能替代 GitHub Actions 的实际结果。

| 环境与 Node | `setup` | `check:static` | 完整 `check` |
| --- | --- | --- | --- |
| macOS，22.19.0 | 7.50 s | 9.10 s | 192.71 s |
| macOS，24.15.0 | 复用同一检出安装 | 7.81 s | 198.46 s |
| Linux，24.15.0 | 22.31 s | 34.01 s | 529.63 s |

三组完整检查均为应用 1024 通过、1 跳过，基础验证 9 通过、1 跳过、0 失败；跳过的是显式关闭的真实模型检查。macOS 使用最后验收快照 `95ace397`（临时仓库提交）。Linux 全量使用 `f8c61b9`；之后唯一变化是协作测试等待模型记录的条件，已在 Linux 通过最新静态检查及相关用例复核。应用源码、检查配置与依赖未再变化。

最终应用源码的 Docker 04/13/15/18 共 27/27 通过，模型与消息平台为桩；唯一镜像标签和本次容器均已清理。Linux Node 24.15 的默认 `60fa19e` 升级检查 4/4 通过，用时 65.40 s；两份安装、后台、档案与本次编译缓存均已清理。真实模型、真实 IM 以及 sudo/systemd 验收未在该批次执行。

该批次确认并修复两项兼容性问题：实例锁的持有者身份改用系统采集的 `processIdentity`，机制、逃逸路径与护栏见[复盘 0001](postmortem/0001-instance-lock-identity-by-command-line.md)；Node 22 把 SQLite 编号占位符 `?1` 视为命名参数，两处账本查询经原生 SQL 与真实 Store 方法复现后改为按名称绑定，支持边界由 CI 的 Node 22.19 矩阵覆盖。

其余失败来自测试夹具：人工审批快照需等 `reviewStatus=asked_owner`，模型请求和释放回调需等实际就绪，不能只凭任务运行或投递登记；授权列表按时间及 ID 排序，测试改为按目标授权 ID 选择。长检出名叠加临时 HOME 超过 Unix socket 路径限制，已缩短测试前缀，并补齐异常启动时的监听清理和提前退出诊断。这些等待问题均通过受控顺序复现后修复，永久夹具没有新增固定延时或自动重试。

Linux 首次新安装因该批次旧检出的重复依赖占满空间而出现 `ENOSPC`；只清理本次可重装的旧依赖后，默认 `setup` 完成。调试中的失败与手动中止保留为诊断记录，不计入上表。版本和覆盖内容存在差别，墙钟耗时用于选择日常反馈方式；性能优化按慢用例和实际修改困难另定。

全库格式统一、旧特权脚本的隔离改造、有证据支持的结构重构分别另做批次。每批以当前反馈入口验证，保持产品命令、配置、持久化资料和权限行为兼容。架构原因以[CONTEXT.md](../CONTEXT.md) 与 [决策笔记](../.agents/notes/) 为准，本地任务继续按[issue tracker](agents/issue-tracker.md) 管理。

改造前的 `npm audit` 记录有 4 项既有依赖问题（1 项 moderate、3 项 high），该批次保留已有包版本。依赖修复另做批次，涉及 pi SDK 主版本升级时单独评估 API 与产品兼容性。
