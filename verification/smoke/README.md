# 产品验证入口

在已安装依赖的检出目录中运行。脚本使用本次创建的临时档案、工作区、mock 或显式指定的模型凭据和独立工具执行单元；核实停止后清理本次资源。没有 SSH 上传入口，在 Linux 的隔离检出目录也运行相同命令。04/13/15 不接受参数，旧的 `--remote` 会报告前提缺失。

| 命令 | 真实资源与模拟范围 | 前提 |
| --- | --- | --- |
| `npm run test:native` | Coding 04：原生修改、检查、审批与回收；13：SubAgent 协作通信；15：恢复。模型使用本地桩；不启动个人 IM、调度或旧个人装配 | `npm run build`，Linux 正式 bwrap/profile、user manager、scope/cgroup 委派，见 [原生前置](../../deploy/native/README.md) |
| `npm run test:upgrade` | Coding 的临时旧版/新版安装、历史/审批/产物/工作副本保全与升级；模型使用本地桩，旧后台按该版本允许的能力执行；不将旧个人档案加载新入口 | npm、tar、可下载或已缓存的锁文件依赖；Git 历史中的 `8bccb8f` 或显式 `SMOKE24_BASE_TAR` |
| `npm run test:release-model -- --models /absolute/models.json --model provider/model` | 指定真实模型在原生沙箱里修复代码、修前失败/修后通过、PTY TUI 退出后继续与重连；会调用真实模型并可能产生费用 | `npm run build`、原生执行前置、Python 3 的 pty、显式模型配置与凭据 |
| [个人 durable 真实模型入口](../../docs/usage.md#25-个人-agent-引导与管理) | 独立后台间重启，真实模型保存/读取记忆、加载技能、单事务写入应用数据并重启查询，核对原请求证据；不接 IM | Pi 1.3.0 依赖、显式模型开关及配置；凭据仅经进程环境，不复制到档案 |
| `RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/absolute/models.json npx tsx --test test/123-workflow-model-acceptance.test.ts` | Coding 与旧共享库测试声明的 DeepSeek 通过工具发起命名工作流、等待期间聊天、业务回答、真实工具与唯一汇总；不发送真实 IM，调用可能产生费用 | 已构建原生 worker，显式文件中有可独立调用的 DeepSeek 配置；失败保留隔离档案 |
| `npx tsx verification/smoke/smoke-26-native-worker.mts` | 模型打桩；真实四工具、宿主编译、文件与网络拒绝、身份/硬链接检查、启动取消及回收；正式入口无后端覆盖，不依赖 Docker | `npm run build`；macOS 原生监督器或 Linux bwrap/profile、user scope |
| `npx tsx verification/smoke/smoke-26-native-worktrees.mts` | 模型打桩；真实 Runtime、控制面与原生 worker 修复代码、限定只读委派、并行双 worktree、共享 Git 拒写及汇总，不依赖 Docker | `npm run build`；macOS 原生监督器或 Linux 正式 bwrap/profile 与 user scope，见 [原生前置](../../deploy/native/README.md) |

`test:native` 顺序运行 04/13/15 三个 Coding 脚本；旧个人 18/27/28 不再作为当前可执行入口。退出码统一为：0 表示所有检查通过，1 表示检查、运行或清理失败，2 表示参数错误或缺少运行前提。2 不表示验证通过，不能作为 CI 的成功结果。`test:release-model` 提供 `--help`；真实模型与升级是独立门禁，不会因运行其中一个而自动执行另一个。

个人 durable 的 OS 验收另在 Linux 隔离档案运行，不能用上述 Coding 复跑替代；`TMPDIR` 可选择本次临时资料所在位置。launcher 需要正确的 `XDG_RUNTIME_DIR` / `DBUS_SESSION_BUS_ADDRESS` 管理 user scope；这些变量不会传入受限 worker。原生临时目录使用宿主磁盘，不设置容量配额，停止未核实保留现场。

`test:release-model` 只复制 `--models` 文件中所选 provider 和 model 的配置，以 0600 保存到临时档案。启动 TUI 前，在同一子进程环境白名单下调用现有 `probeModelConfig` 离线核实配置、认证、思考档位与预算；明确使用临时 `auth.json` / `models.json` 路径，不刷新在线模型目录、不调用模型。提供的配置需能独立通过 SDK 的认证检查；仅存在 `headers` 不代表认证可用。脚本不会自动读取相邻的 `auth.json`、日常实例档案或继承环境中的模型 API key。模型检查固定关闭 thinking，所选模型必须支持此设置。缺认证等前提退出 2，并清除临时配置；脚本始终停用真实 IM。

Coding Runtime 冒烟记录本次真实执行单元，核实停止结论与 Linux 已观察 cgroup 为空或消失后才清理。恢复冒烟的清理会分别尝试停止 Runtime 和关闭模型桩。停止或关闭失败会计入 FAIL，退出 1 并保留临时现场，避免把未核实停止的资料删除或报告成功。

原生 worktree 冒烟不接受参数，使用本次虚拟配置与资料，不读日常凭据。夹具 Git 初始化也由原生 worker 执行；创建及汇总沿运行时受限入口，父任务在委派期间保持活动与目录占用。退出 0 为八项实际通过，1 为实际失败，2 为原生能力不可用；失败时保留现场供核实。模式、授予变更、IPC 与整单元停止由原生探针和原生 worker 冒烟另行验证，不能用模型打桩覆盖这些 OS 证据。

升级分别构建旧版和新版，核对已消费的审批、JSONL、产物字节和真实修改副本。停止未核实的异常形态由裸 SQLite 播种，升级后核对中断、效果未知、暂停与精确占用均保留；它不替代真实强杀证据。通过后仍保留这两个明确的异常占用及临时档案，不自动 resume-queue 或删除现场。其他停止未核实与清理失败退出 1。

升级默认从 `8bccb8f` 验证 Coding 的 `ruukoto-code` 产品身份，可用 `SMOKE24_BASE` 指定具备相同入口、产品身份与当前控制面协议的其他提交。无 Git 历史时用 `SMOKE24_BASE_TAR=/absolute/base.tar npm run test:upgrade` 提供由可信 `git archive` 生成的版本包。浅 clone 缺少基点会退出 2。历史记录中的 `1aba2f1` 验收反映当时的 `ruukoto-dev` 产品名称；当前入口不验证跨产品名称或资料身份迁移，不将旧证据改写为这种兼容保证。

当前复跑由本目录的 04/13/15、24（含 `pty-run.py`）提供。旧个人 18/27/28 的历史结果保留在对应工单及发布记录，不再提供旧个人入口复跑。09、10 的驱动、远端编排器、共享 backendctl，以及 Linux 完全访问 24 保存到 [../archive/](../archive/README.md)，作为六份不可执行文本。它们依赖既有 sudo/systemd 配置，09/10 会覆盖并保留生产部署路径，必须先建立独立演练资源和清理契约才能恢复为可执行门禁。
