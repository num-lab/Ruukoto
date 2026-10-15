# 桌面骨架实施与验收

实施基点 `8faca2a`；环境为 macOS Apple Silicon、Node 24.15.0、Electron 44.7.2。实现、验证与独立审查由不同执行上下文完成，所有后台与 socket 探针使用临时档案，未连接或停止日常实例。共享要求见[规格](../spec.md)，入口见[工单](../issues/03-desktop-skeleton.md)。

## 实现范围

新增 apps/desktop：Electron 主进程持有连接、令牌与后台拉起；sandbox CommonJS preload 提供四个桥接入口；React/Tailwind 渲染进程消费 view 显示 Code 状态与工作区。日常环境从登录 shell 取得，受管环境来自启动器且不重新执行 shell、不调用 ensureBackend。版本信息以结构化字段穿过控制客户端、连接回调、ensureBackend 与 IPC，协议未升版。版本拒绝后只显式重新连接，日常模式重新探测／拉起，受管模式仅连接。

开发启动器增加 Code 专属 --desktop，使用独立进程组与随机 base64url nonce。electron-vite 负责桌面及其打包依赖的监听，启动器只重启后台。生产 CSP 插件与检查器共用常量，开发 CSP 使用响应头与 nonce；产物检查拒绝 CSP 缺失／错位、开发 nonce、拆分或 ESM preload，以及未打包的外部依赖。

桌面依赖仅在本包 devDependencies，根锁文件管理；边界规则只为 desktop 放开 devDependency 值引用。electron-builder 的默认依赖收集会把根生产树带进应用，显式排除 node_modules 后，最终 app.asar 为 668,595 bytes、11 个条目，没有 node_modules。根 build 不触发 Electron。CI 设置跳过 Electron 二进制下载。

新增 desktop 模块文档，更新架构、术语、使用、开发、检查入口与相关笔记；历史耗时整节移到 docs/development-baselines.md，内容逐字保留；桌面详细开发放 docs/desktop-development.md。常驻入口保留原锚点与链接，没有提高文档预算。

## 定向与隔离验证

| 检查 | 结果与覆盖 |
| --- | --- |
| 作者 control：12/66/72 全文件 | 65/65，通过；真实 bin、socket、锁竞争与双向版本链；撤去实现后新增 3 项全部失败，恢复后通过 |
| 作者 launcher：32/71 全文件 | 46/46，通过；参数、环境、监听、Python PTY 与替身 electron-vite/Electron 整组清理 |
| 汇总桌面 38-main、38-build、39、99 | 17/17，通过；真实 Vite 插件构建、CSP 正负例、主进程处理函数、转义与 macOS lsof 真实定位 |
| npm run check:static | 汇总 lint、根／workspace／foundation 类型、笔记与文档门禁全部通过 |
| 汇总修订后 38-main | 6/6，通过；规范调整不改变异常覆盖与连接行为 |
| 汇总 nonce 修订后桌面开发集成 | 1/1，通过；base64url 格式、每次不同与整组退出 |
| 根 npm run build | 通过；生成原生／worker／WASM 和两产品 tarball，未构建或打包 Electron |
| npm run desktop:build | 通过；electron-vite 三目标、check-build 与 macOS arm64 目录应用 |
| codesign --verify --deep --strict --verbose=2 | 最终 Ruukoto.app 通过；11 条目的最终 asar 不含 node_modules |
| 隔离 npm ci --omit=dev | 实际安装通过，未安装 Electron；独立审查另核实 electron-builder、electron-vite、React、Vite 均不存在 |
| 隔离 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm run setup -- --skip-hooks | 干净检出安装通过；Electron 包存在，二进制与 path.txt 不存在 |

隔离 setup 首次探针因副本缺少 .git 被前置检查拒绝；初始化隔离 Git 检出后成功，该次拒绝不计为通过。依赖安装报告的审计告警未在本单跨范围升级处理。旧锁中已有依赖的版本没有改变。

## 独立实现审查

审查者 A 直接读取桌面、构建检查、边界、启动器、文档与笔记，亲自执行 38/39/99 的 17 项、32/71 的 46 项和修订后主进程 6 项，检查产物与隔离生产安装。发现两处多语句 try 违反仓库约定，改为单语句 await 后复核关闭；当前无未解决实现阻断。该审查者不把自己编写的 control 计为独立审查。

审查者 B 独立覆盖 control、桌面构建、依赖和 CI 配置，亲自执行版本最窄 4 项与构建／边界 10 项，复核 preload VM、生产安装、最终签名和 asar。发现其他包 devDependency 反例会同时触发层级错误，补为明确要求 undeclared；把例外错误扩大到所有包的变异会使新断言失败。当前无未解决实现阻断；该审查者不把自己编写的 launcher 计为独立审查。

## 真实 Electron

最终签名 .app 使用受控登录 shell 与临时 Code 档案：四个 preload 入口均可实际调用，文件夹选择框打开后取消返回 null；renderer 的 require/process 均为 undefined；生产页面 head 首元素为严格 CSP，注入无 nonce 的内联脚本出现 CSP 拒绝事件。应用实际拉起后台，第二个控制客户端可认证同一后台，新增工作区实时出现在列表；名单外请求被主进程拒绝，订阅状态／快照／事件不携带令牌。关闭应用后 Electron 退出，临时日常后台仍可握手，再由验收脚本单独停止并清理。

独立真实受管验收已覆盖：启动器使用临时 HOME 与开发档案，不执行设置为陷阱的登录 shell；nonce 与开发 CSP 下 React/Tailwind 资源加载正常，无 nonce 内联脚本被拒绝、有 nonce 脚本可执行；明暗两种外观截图已检查。renderer 文案 HMR 与复原、main 重建更换 Electron、view 源码热更新、后台源码重启后自动重连均通过。临时模型配置损坏导致受管后台重载失败后，重启前端并观察 6 秒，没有 spawn.log、control.sock 或自行派生的后台；恢复临时配置后再次重载，自动恢复 online。关闭窗口后启动器 exit 0，所记录的 9 个拥有进程全退出，socket 移除。

真实版本 GUI 的两种方向均显示 v25/v24 或 v25/v26 与正确更新提示，2.5 秒观察中替身后台只收到一次连接。日常旧后台场景由验收者结束自己创建的旧替身后点击界面“重新连接”，ensureBackend 实际拉起新后台并恢复 online。恢复只对临时实例操作，不执行日常后台停止。

preload 真实监听另检出了实现缺陷：electron-vite 虽报告重建并发送 full-reload，main 的无条件 will-navigate 拦截却阻止 Electron 重载，并打开了没有 preload 的系统浏览器开发页面。修复只允许完整配置开发文档 URL 的自身重载，其他路径、查询、来源与协议继续拦截；单测补安全正负例，文档如实区分 main 重启与 preload 页面重载。修复后真实短验确认旧渲染执行上下文销毁、sentinel 清除、四桥重新注入，require/process 仍为 undefined，连接恢复；control 与 core 源码分别触发主进程重建和 Electron 重启，均恢复 online。固定 CDP 端口在快速重启时有释放竞态，各补一次 touch 后取得调试连接；这是插桩限制，不作为应用重试。三处 touch 文件 SHA-256 未变。最终关闭后所捕获的 9 个拥有进程全部消失、socket 移除。独立审查通过精确 URL 的正负例与 reject-all／origin-only 变异；随后将空开发 URL 改为先短路拒绝，另一独立审查者亲自复核并执行 38 的 6 项，通过，无剩余实现阻断。

## 交接与未覆盖

本机工程与真实 Electron 检查通过，主观外观体验仍待拥有者验收。版本 GUI 用自建 socket 替身，恢复是关闭自己的旧替身再点重新连接；未声称对真实旧 commit 后台完成 lsof 核对与 SIGTERM，该人工流程仍待外部演练。GitHub Actions 四个 job、Linux／Node 22 矩阵和全量 npm run check 未运行，隔离本机安装不代替实际 CI。04 及之后的交互功能、Personal、自动停止旧后台均不属于本单。

最后空串保护之后重新执行桌面 38-main／38-build／39 共 12 项、桌面定向 ESLint 与 typecheck、desktop:build，全部通过；此前导航修复后的完整 check:static 已通过。独立空串复核 6/6 通过。拥有者已授权本地提交；未推送、合并、部署或发布。
