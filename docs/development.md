# 开发与验证

在仓库根运行：npm workspaces 含 `packages/*` 与 `apps/*`，共用根锁文件；`verification/foundation/` 保持独立包和锁文件。应用复用基础验证，基础验证也引用根目录的测试助手；用例与助手在根 `test/`。

```bash
npm run setup
npm run check
```

`setup` 检查 macOS / Linux、普通用户账户、Node ≥ 22.19、Git、ripgrep（`rg`）、Bash、Python 3 与 PTY ，再在根目录和 `verification/foundation/` 执行 `npm ci` 并安装 Git 管理的 pre-commit 钩子。首次安装需网络；`check` 使用本地 mock 模型和临时数据，不需要模型凭据、Docker、真实 IM 或系统服务。依赖变化时更新对应 `package.json` 与 `package-lock.json`并重跑 `setup`。

macOS 构建原生监督器另需 Command Line Tools 的 Clang。平台前置、真实证据与复跑命令见[原生边界验证](../verification/foundation/scripts/native-isolation/README.md)；离线 local 测试不证明 OS 边界。

## 跨模型协作

交接时给出工单路径与角色。[开发流程](../.agents/skills/development-workflow/SKILL.md)定义交接和验收；角色和模型独立选择；工程、产品验收分开记录。

## 日常反馈

| 命令 | 检查范围与产物 |
| --- | --- |
| `npm run build` | 构建原生监督器、工具与脚本 worker 及 WASM，再生成两产品的 `dist/*.tgz`；无需 Docker，应用通过 tsx 运行源码 |
| `npm run build:worker` | 打包共享 `worker/worker.mjs`、独立 `worker/background-worker.mjs` 及自包含的 `worker/personal-command-worker.mjs`、`worker/personal-file-search-worker.mjs`；个人命令使用 Linux 原生执行，资料检索另用只读资料根 |
| `npm run desktop:mygo` / `npm run desktop:mygo:build` | 重建并启动／只构建 MyGo 试验应用，要求 macOS arm64 和 Go ≥ 1.27.1；详见[桌面开发](desktop-development.md) |
| `npm run desktop:build` | 构建桌面三个目标、检查产物并 ad-hoc 签名 `dist/mac-arm64/Ruukoto.app`；根 build 不打包 Electron |
| `npm start`、`npm run personal:durable` | 同一正式个人菜单，默认 `~/.ruukoto-durable/`；`RUUKOTO_PERSONAL_DIR` 选择新目录；`serve --directory <绝对路径>` 固定服务档案，`settings` 用有界 JSON 在线读、离线持锁改，`maintenance` 核实原服务并显式启停；见[个人操作](usage.md#25-个人-agent-引导与管理) |
| `npm run dev`、`npm run dev -- --config` | 默认由 Node watch 托管个人开发后台；`--config` 直接运行不监听源码的同档案菜单；固定检出散列档案，不继承正式目录，已启用 QQ/Telegram 时拒绝启动，退出停止本次后台 |
| `npm run build:script` | 打包 `worker/workflow-script.mjs` 并复制同目录 WASM；脚本测试前运行 |
| `npm run lint` | 检查正确性与关键约定，不统一全库排版 |
| `npm run typecheck` | 根测试与脚本、每个 workspace 包、基础验证各自执行静态类型检查 |
| `npm test` | 应用与基础验证的全部离线测试；真实模型用例按默认开关跳过 |
| `npm run check:static` | 依次执行 lint、类型检查、笔记门禁与文档门禁（链接、源码引用、篇幅与段落形态） |
| `npm run check` | 依次执行环境检查、build、`check:static` 与全部离线测试，任一步失败即停止 |
| `npm run test:app` | 仅应用离线测试；macOS 先串行执行脚本中列明的原生停止与后台恢复夹具，再并行其余；其他平台全并行 |
| `npm run test:foundation` | 仅基础验证离线测试 |
| `npm run change-scope -- --base <ref>` | 报告本次改动相对 merge base 的已提交、暂存、未暂存与未跟踪路径 |

修改时跑 `npm run check:static` 与定向测试，按[改动面](../.agents/skills/pre-push-checks/SKILL.md)选检查；全量 `check` 仅用于明确要求、CI 故障或跨全仓改动。定向测试写文件名：

```bash
npx tsx --test test/71-product-entry.test.ts test/32-dev.test.ts
npx tsx --test verification/foundation/test/03-tools.test.ts
```

按功能词及调用者选测试；下表列起点，全表用 `rg --files test`。

| 修改位置 | 常用测试起点 |
| --- | --- |
| `packages/tui/src/`（cli.ts、cli-entry.ts、dev.ts）、`packages/core/src/product.ts`、`apps/ruukoto-code/src/dev.ts` | `test/29-cli-entry.test.ts`、`test/32-dev.test.ts`、`test/71-product-entry.test.ts` |
| `apps/ruukoto/src/personal-*.ts`（独立 Pi 1.3.0） | 配置、机器设置、外部占用、托管技能、菜单、IM、正式入口与打包用例按[个人入口检查集](../.agents/skills/pre-push-checks/SKILL.md#2-按面选证据)选择；会话后台用 `test/personal-background-processes.test.ts`，`ssh tx` 隔离目录另跑同文件“真实Linux”用例；真实模型用 `verification/smoke/smoke-personal-durable.mts`，前提见[操作手册](usage.md#25-个人-agent-引导与管理)。生产切换单独验收 |
| `apps/ruukoto/src/service-helper.ts`、`deploy/systemd/ruukoto-service.mjs` | `test/service-helper-transport.test.ts`（传输退出/捕获）、`test/service-helper-stop.test.ts`（Linux 进程/系统命令桩）；helper 与旧存储规则分别为 `test/78-linux-service-management.test.ts`、`test/79-standing-permissions.test.ts`，新调用方为 `test/personal-services.test.ts`、`test/personal-service-operations.test.ts` |
| `packages/runtime/src/` 与 `packages/control/src/` 的任务生命周期 | `test/01-concurrency.test.ts` 至 `test/05-overflow-db.test.ts`、`test/66-control-seam.test.ts`、`test/94-task-ending.test.ts` |
| `packages/agent/src/` 的执行、审批与权限 | `test/07-real-tools.test.ts`、`test/08-approvals.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts` |
| 浏览器 | `test/browser-tools.test.ts`、`test/browser-lifecycle.test.ts`；[验收入口](../.scratch/agent-browser/evidence/implementation-checks.md) |
| Coding 会话后台 | `test/background-processes.test.ts`、`test/background-processes-recovery.test.ts`；core、客户端、平台串行前提与真实browser/模型入口见[后台检查集](../.agents/skills/pre-push-checks/SKILL.md#2-按面选证据) |
| `packages/agent/src/script-worker/` | `test/104-workflow-script.test.ts`、`test/100-worker-stop.test.ts` |
| `scripts/test-app.mjs` 的分批与退出 | `test/124-test-app-runner.test.ts`；共享 UID 孤儿冲突的独占清单由脚本持有 |
| 工作流存储、协调器、真实步骤与宿主操作 | `test/105-workflow-runtime.test.ts` 至 `test/113-workflow-source-capabilities.test.ts`；新增角色/版本回归见 `test/workflow-*.test.ts` |
| 回答、送达、调度与等待 | `test/114-workflow-owner-input.test.ts` 至 `test/116-workflow-notification-recovery.test.ts`；`test/125-agent-wait*.test.ts` |
| 持久问题与恢复 | `test/owner-questions.test.ts`、`test/owner-question-*.test.ts`；12/13/14/15、41和66按影响补回归 |
| 工作流定义与入口 | `test/117-workflow-library.test.ts` 至 `test/120-workflow-cli.test.ts`；126 侧栏与恢复，模型/IM 替身 |
| 共享底座六输入联合验收 | `test/121-workflow-personal-acceptance.test.ts`、`test/122-workflow-code-acceptance.test.ts`；真实工具、联网/IM 替身 |
| `packages/agent/src/` 的上下文与模型 | `test/18-model-selection.test.ts`、`test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`、`test/98-media-model-pinning.test.ts` |
| SubAgent、角色/工作区快照、worktree 与导入 | `test/80`–`87`、`91`、`95`；在 test/ 按 subagent-role、subagent-definition、workspace-snapshot、subagent-workspace-snapshot、work-copy-host 找文件 |
| `packages/tui/src/tui/`、`packages/tui/src/config-tui/` | `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/33-config-tui.test.ts` |
| `apps/desktop/` | 终端必跑`test/desktop-terminal.test.ts`；纯逻辑测试、MyGo 检查与真实外壳验收见[桌面开发](desktop-development.md#测试导航) |
| `packages/view/src/` 的共享投影与浏览器约束 | `test/36-event-flow-state.test.ts`、`test/37-view-browser.test.ts`；TUI 调用方另跑 13/14/34/19 |
| `packages/channels/src/qq/`、`packages/channels/src/telegram/`、`packages/channels/src/scheduler/` | `test/26-qq.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/38-telegram-owner.test.ts`、`test/40-qq-private.test.ts`、`test/89-im-entries.test.ts` |

失败记录用例名、断言与环境；区分回归与前提，独立复现再修复。默认检查和 CI 不重试。[历史验收](release-acceptance.md)不证明当前代码通过。

`FIXME` / `TODO` / `XXX` 的规则见[仓库约定](../AGENTS.md#约定)。

## 提交与 CI

pre-commit 依次执行暂存内容的行尾检查与 `npm run check:static`：`git diff --cached --check` 拦行尾空白与文件末尾空行，`scripts/check-staged-eol.mjs` 拦末尾缺换行或多出空行。完整离线检查由 `check` 与 CI 执行。安装时检查已有 `core.hooksPath` 和 pre-commit 配置，遇到冲突会在安装依赖前停止，保留原钩子。若沿用自定义钩子，先将 `npm run check:static` 接入原配置，再运行 `npm run setup -- --skip-hooks` 安装依赖；若使用仓库钩子，先备份并移走原配置，再运行默认 `setup`。已有钩子的来源可用 `git config --show-origin --get core.hooksPath` 核对。已有 `core.hooksPath` 指向当前仓库的 `.githooks/` 时，`setup` 检查入口可执行后直接复用。

未配置 `core.hooksPath` 时，Git worktree 共用钩子目录，`setup` 在其中安装固定转发脚本，每次提交执行当前检出的 `.githooks/pre-commit`。主检出与 linked worktree 均可安装并复用转发脚本，切换分支或删除其他 worktree 不改变本检出的检查入口。旧检出没有仓库钩子或 `check:static` 时明确提示跳过；这种兼容不代表旧分支已验证，需要按该版本的开发说明单独检查。

CI 设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，只检查桌面类型、lint 与纯逻辑，不下载或运行 Electron。

GitHub Actions 在 macOS / Linux × Node 22.19 / 24.15 四组环境执行 `npm run setup -- --skip-hooks` 与 `npm run check`；CI 直接执行检查，不安装提交钩子。最低版本覆盖支持边界，Node 24.15 覆盖本次约定的开发版本；环境缺少 Python 或 PTY 能力时失败，不通过跳过终端用例取得绿色结果。提交钩子和 CI 使用相同的根目录命令。

`worker/` 由构建生成，QuickJS core 与 release-sync WASM 由 agent 包锁版；`node_modules/` 由锁文件安装。个人命令与检索的定向测试见上表链接的检查集；测试前运行 `npm run build:worker`，真实 Linux 停止另行验收。数据库、令牌和凭据留在产品档案，不入工作树；测试用临时档案。开发实例的隔离与执行后端见 [README](../README.md#开发本项目)。

## 外部验收

持久提问真实验收：`RUN_MODEL_CHECK=1 RUN_OWNER_QUESTION_MODELS_FILE=/path/models.json npx tsx --test test/owner-question-model-acceptance.test.ts`（显式DeepSeek、隔离档案）；TUI/Desktop另验。

| 根目录命令 | 所需环境与覆盖 |
| --- | --- |
| `npm run linux:probes` | Linux 原生前置；bubblewrap、namespace、seccomp 与 user scope 边界探针 |
| `npm run test:native` | Linux、已构建 worker 与原生前置；Coding 工具、SubAgent 协作与恢复，模型为桩；个人 durable 能力使用个人窄测与独立外部验收 |
| `npm run test:upgrade` | Git、依赖安装网络与基线版本；smoke-24 的 `--upgrade-only` 路径，使用 mock 模型 |
| `npm run test:model` | `~/.pi/agent/` 的模型配置与凭据；按 provider 尝试短往返，首次成功后停止 |
| `npm run test:release-model` | 已构建的原生执行入口、Python PTY 与显式模型配置；smoke-24 的真实模型编码、TUI 退出后继续与重连 |
| [真实工作流模型命令](../verification/smoke/README.md) | DeepSeek 与原生 worker；保留旧底座/Coding 工具启动、等待聊天、实际工具与唯一汇总，不代表新个人入口验收 |

原生边界按[平台脚本](../verification/foundation/scripts/native-isolation/README.md)单独验收；缺能力或对照时返回不可验证；离线用例不替代真实 OS 证据。

脚本参数、模型认证、退出码与清理见 [smoke 说明](../verification/smoke/README.md)，模型凭据放在工作树外的受保护文件。升级基点与旧名称边界见[复跑说明](release-acceptance.md#当前复跑入口)。`test:model` 缺配置跳过，不计通过；模型编码与安装升级分别验收。历史 Docker 不替代 Linux 原生权限证据，模拟 IM 不代表真实平台通过。旧 systemd/sudo 脚本见[特权归档](../verification/archive/README.md)，恢复执行前隔离系统写入。当前证据与人工项目见[发布验收](release-acceptance.md)。

## 开发实例

`npm run dev` 使用正式个人 CLI 的同一装配，默认前台运行开发后台；`npm run code` 使用 Coding 开发启动器并默认打开 TUI。

```bash
npm run dev                         # Node watch 托管个人开发后台
npm run dev -- --config              # 个人开发档案的引导菜单
npm run code                        # Coding 开发后台与 TUI
npm run code -- ../my-project        # 在指定目录打开新 Coding 会话
npm run code -- --config             # Coding 开发配置中心
npm run code -- --import-models ~/.ruukoto-code/agent
```

个人开发档案固定为 `~/.ruukoto-durable-dev/<检出 realpath hash12>/`，忽略继承的 `RUUKOTO_PERSONAL_DIR` 与旧目录变量，保留旧 `~/.ruukoto-dev/` 归档，不复制模型或服务凭据。先用 `--config` 配置模型，凭据由本次进程环境提供。根与 app 的 dev 脚本经 tsx 进入同一薄启动器；无参由它托管 `node --watch --import tsx` 前台后台，转发停止信号并等待退出，源码变更先停原后台再重启。启动失败时 watch 可等待修正文件。`--config` 直接在本进程打开菜单，不监听源码；菜单启动的后台同进程托管，退出便停止，配置菜单源码变化须退出重开。开发档案已启用 QQ/Telegram 时直接拒绝，保留配置与记录，不连接平台或使原发送换代；真实入口配对与演练使用另选新目录的正式入口。

Coding 档案固定为 `~/.ruukoto-code-dev/<仓库>-<哈希>/`，含 `data/agent/control/pending/logs`，与日常档案的锁和控制面分开。`--import-models` 只复制 `models.json` 与 `auth.json`，不复制服务凭据和默认模型文件；首次也可用 `--config` 配置。

以下为 Coding 开发启动器行为：

- **工作区入口**：位置路径须为已存在目录，与 `--config` 互斥，按真实身份创建或复用工作区并进入新会话；保护根、代码目录与路径校验沿日常入口，源码重载不再次创建会话。
- **环境与执行**：清除继承的两产品路径、生产 owner token、服务配置与执行覆盖，再固定 Coding 身份和档案；停用 QQ/Telegram，默认 native，原生前提缺失时明确失败。
- **进程与重载**：拥有本次后台和前端进程组；退出 TUI/配置中心、Ctrl+C 或关闭终端统一清理。已有外部后台时拒绝，不附加或停止它。监听 `packages/*/src/` 与 `apps/*/src/`，后台变更优雅重启，任务界面重连；只改界面不重启后台，view 归任务界面。配置中心随后台重载并恢复分区。修改启动器须手动重启 npm 命令。
- **界面恢复**：当前会话、未提交草稿与继续意图按实例保存，秘密表单重新输入；无效状态提示后正常进入，不静默把继续草稿转新任务。日志分别写 `backend.log` 与 `dev.log`，不与界面输入串写。
- **配置引导**：`--config` 缺有效模型时先进入离线配置，保存并释放锁后启动后台；放弃或保存失败不启动，退出配置中心结束本次开发运行。

## 桌面客户端

`npm run code -- --desktop` 使用隔离开发档案，与 --config 和位置路径互斥；electron-vite 负责桌面及其依赖的重建和 HMR，启动器管理后台与整组退出。构建、Electron 下载前提及验收见[桌面开发](desktop-development.md)。

纯前端界面参考见 [shadcn demo](../.scratch/desktop-shadcn/demo/README.md)，独立安装与启动，不依赖 Electron 或后台；正式 GUI 按已冻结定稿迁移，冻结源码与验收证据位于同一目录。

## 耗时基线与后续批次

历史平台耗时、检出版本与覆盖限制见[开发耗时记录](development-baselines.md)。这些数据用于选择反馈方式，不证明当前代码通过。
