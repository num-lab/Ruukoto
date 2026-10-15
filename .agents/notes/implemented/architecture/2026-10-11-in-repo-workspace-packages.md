# Agent Note: 两个产品在同一仓库内改为 workspaces 分包

Status: implemented

## 问题

两个产品共用单代码包，产品差异缺少显式归属，模块依赖只能靠文档约束。[产品入口决定](2026-10-02-two-agent-products.md)原先只在独立发货需要出现时重访分包；这次驱动是产品装配与可检查的依赖方向。原提案测得约 76% 源码是共享底座，拆仓会放大 worker、schema、协议与共享测试的版本协调成本。

`agent/subagent-tools.ts` 直接从 runtime 引入格式化与账本核实，control 从 runtime 引入模型选择解析，通用来源核实又寄存在个人调度工具里。仅搬目录会把这些反向依赖带进新包，不能解决边界漂移。

## 决定

根包作为安装、开发、构建与检查的聚合入口。npm workspaces 收入 `packages/*` 与 `apps/*`，九个包使用同一根锁文件与版本。每包有自己的 package.json、exports、依赖与 typecheck；包内相对引用带 `.ts`，跨包通过包名解析 `.ts` 源码。tsx、tsc 的 bundler resolution 与 esbuild 均直接使用 exports，不另建 paths 别名或编译后的源码副本。

| 包 | 归属 |
| --- | --- |
| `@ruukoto/core` | 存储、身份、schema、历史读取；导入方向共用的快照、文件校验、行与回执辅助；模型选择字段解析 |
| `@ruukoto/agent` | 模型、上下文、通用工具、审批与执行边界；SubAgent 格式化与账本核实 |
| `@ruukoto/channels` | QQ、Telegram、GitHub、调度；IM 审批、入口表、入站媒体、个人导入、GitHub 退役；资料来源核实、旧群结果查询与个人工具的旧账本规则 |
| `@ruukoto/runtime` | 任务生命周期、编排器、SubAgent、父级送达、工作副本与工作区组织迁移 |
| `@ruukoto/control` | 控制面协议、认证、客户端与服务器 |
| `@ruukoto/view` | 浏览器可用的快照、事件、历史与任务详情投影，客户端共用选择器与状态文字 |
| `@ruukoto/tui` | 共享 CLI、任务界面、配置中心、开发启动器与程序化聚合入口 |
| `ruukoto` app | 个人产品 bin、主入口、开发入口、能力声明、调度与服务工具装配 |
| `ruukoto-code` app | Coding 产品 bin、主入口、开发入口、能力声明与旧开发资料导入策略 |

产品能力在各 app 的 `product.ts` 持有：RuntimeProduct 提供身份、IM、调度、服务可用性与工具族工厂；CliProduct 提供默认执行后端、旧项目写资格与导入方向。Runtime.start 必须接收显式产品声明，共享运行时不按 ProductType 分支装配。身份继续用于 `product.type` 登记和跨产品目录拒绝，不由模型或任务参数决定。

两个 bin 各自固定身份。根 `npm start` 通过 `scripts/start.ts` 保留已有环境身份选择，默认 ruukoto；各 app 的 start 固定自己的 bin。root 的 dev/code 直接运行对应 app 的开发入口，公共启动器监听各 workspace 包的源码，view 变化只重载任务界面，子进程仍使用所属产品的 bin。

## 依赖与兼容

运行时值依赖固定为 `agent → core`、`channels → agent/core`、`runtime → channels/agent/core`、`control → core`、`view → control/core`、`tui → view/control/runtime/agent/core`。各 app 可以依赖共享包，产品包之间没有依赖。反向类型放进 devDependencies，core 不接受任何反向引用；跨层运行时协作使用回调或已注入的实例。ESLint 检查静态 import、re-export、类型引用与动态 import，拒绝未声明依赖、越层值引用与跨包相对路径；包内动态 import 使用静态模块字符串。

view 沿用[桌面客户端提案](../../proposed/architecture/2026-10-15-desktop-client.md)的共用投影决定，先承载 `ViewState` 与 `EventFlow`。纯状态常量与展示归属从依赖 Node 的模块拆出，原入口再导出以保持调用方兼容；UTF-8 字节用 `TextEncoder` 计数。view 源码禁止 Node 引用，全部导出以浏览器目标打包后仅按浏览器全局检查，覆盖传递依赖中的未执行分支，再用无 Node 全局的 VM 核实实际投影。

命令执行与 SQLite 持久化留在 TUI 的 `ViewState` 子类，加载/保存失败继续显示提示，保存失败的本地结果不会被旧存储覆盖。EventFlow 保留纯内存命令条目及其统一排序，使重同步保留本地提示与命令；不为这次抽取新增命令存储接口。每次安装快照都由调用方更换异步请求代次，过时代次结果不得安装；全局 seq 缺口检测仍归 `ControlConnection`。

原提案把开发启动器、工作区组织迁移与群结果工具归为产品专属。当前代码中的两个产品都使用前两项，群结果工具也承担旧归档查询，因此它们保留共享。这样无需让个人 app 引用 Coding app，也不删除现有普通开发会话的能力。个人导入原先从 Coding 导入文件复用的通用辅助下沉 core，各方向保留自己的表策略、权限收尾与交接判断。

调度与服务工具实现归个人 app，但旧工具操作的规则、只读分类与提交核实留在共享包，始终提供给 ToolOpLedger。Coding Agent 停用能力不改变遗留操作的恢复结论，也不丢失旧群资料的只读查询。

测试和 test/helpers 保留在根目录，不新增测试包、不改变编号或裸 SQL 布局断言。foundation 保持 workspaces 之外的独立 SDK 验证包、锁文件与 typecheck；setup 继续对根和 foundation 各执行 npm ci。schema 与控制面协议不因分包升版，JSONL、数据目录、授权与凭据格式不迁移。

## 构建与检查

根 build:worker 是 worker 的唯一构建入口，产物仍为 `worker/worker.mjs`；两个 app 的 build 各自产出包含 bin、源码和共享依赖声明的 npm tarball。根 build 先构建 worker，再聚合 app 构建。tarball 不是独立单文件发行版，部署仍使用完整 workspace 安装与同一 worker 镜像；没有引入外部包发布流程。

worker 镜像在构建阶段复制 workspace 源码与清单，按根锁文件安装，单次构建 worker 后移除开发依赖；运行阶段只复制生产依赖与 worker 产物。systemd 使用个人 app 的 bin。根 typecheck 检查测试和脚本，再逐包与 foundation 执行独立检查；check 继续聚合构建、静态门禁与离线测试。

## 备选方案

- 拆成两个仓库可以隔离发布节奏和访问权限，但多数代码与共享硬契约需要长期对齐；当前驱动是源码归属与依赖检查，所以保留同仓。
- 只加 import 规则成本最低，也能挡住现有反向边，但产品差异仍无自己的入口和装配归属；采用分包并同时落实规则。
- 保留相对路径跨包可减少迁移文本，但绕过 exports 与依赖声明，包图无法说明代码引用；跨包统一使用包名。
- 为测试另建共享包能形成测试依赖图，但集中测试已经表达跨模块契约，也不参与产品发货；保留根测试和助手。
- 将 foundation 并入 workspaces 能统一安装，但它承担独立 SDK 与 Linux 探针验证，现有双锁 setup 已有稳定入口；保留独立安装，避免同时改变依赖验证归属。
- 让 view 注入命令存储可直接搬迁整个状态类，但桌面不需要 SQLite 命令历史；TUI 子类只负责本地恢复和保存，避免浏览器投影背上终端持久化接口。

## 后果

产品入口与能力有明确归属，新增越界引用能在 lint 阶段失败；多数源码是路径与 import 的机械迁移，共享运行时与执行边界仍只有一份。代价是维护九份依赖清单与逐包类型检查，反向类型仍需共享源码在同仓可用。独立发布版本与外部注册表发货不属于本次分包，若出现该需求需另定共享包发布与版本协调流程。

2026-10-11 在 macOS arm64、Node 24.15.0 实测：`npm run setup -- --skip-hooks` 干净安装通过；`npm run check` 的构建、八包独立类型检查、静态与文档门禁通过，应用测试 1025 通过、1 跳过，foundation 9 通过、1 跳过。跳过项均为默认关闭的真实模型检查；test/99 验证 bin 链接、各 app 启动脚本以及 import 正负例，test/64 逐产品验证停用个人能力后的旧账本恢复。

新 Dockerfile 构建独立验证标签，使用 Docker 可访问的宿主代理地址适配本机配置；该镜像上的 `npm run test:docker` 四项冒烟共 27/27 通过，模型、QQ 与 Telegram 均为桩。`npm run test:upgrade` 从 `60fa19e` 升级到当前 workspace 布局 4/4 通过，覆盖另一端不停机、历史保留与独立停止；验证镜像与测试容器清理。已有依赖版本、schema 与控制面协议版本均不变。未执行真实模型、真实 IM、systemd/sudo 部署与 Node 22/Linux 后台矩阵，不把 Docker worker 的 Linux 证据当作完整后台平台验收。
