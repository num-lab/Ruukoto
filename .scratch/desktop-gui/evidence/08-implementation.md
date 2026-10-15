# Personal SSH 连接实现与验收

基点：`Eitrous/desktop-gui` 的 `dba2109` 加本轮实现。环境：macOS arm64、Node 24.15.0、Electron 44.7.2。入口：[工单](../issues/08-personal-ssh-target.md)。

## 实现范围

主进程增加 Personal 配置存取、独立 SSH 监督者和双目标状态路由。配置只保存 `host`、`controlDir`，保存和加载时校验；读取与转发复用 shell 转义并禁用 SSH 复用及后台化。每次控制面连接读取原令牌，错误按外部退出码与 C locale stderr 分类，监督者持有取消、15 秒读取期限、TERM/KILL 回收和本地 socket 生命周期。

ControlConnection 支持令牌提供函数，在令牌、factory、认证、握手各阶段核对代次，产品不符在快照安装前终止。协议为 v26，快照 `product` 来自 Runtime；Code 与 Personal 都校验产品，demo 与所有直接构造快照的调用方同步。两层退避各自从 500 ms 增至 8 s，明确 online 才复位。

Personal 界面归后续工单；本轮 bridge 只开放订阅、重连和配置读写。Personal 测试独立为 `test/38-desktop-personal.test.ts`，避免继续扩大原有主进程测试文件；开发导航和检查清单已同步。没有新依赖或后台启动／服务器修改行为。

## 自动化证据

| 检查 | 结果与覆盖 |
| --- | --- |
| `npm run check:static` | 通过；含 lint、全 workspace 类型、notes 与 docs 门禁 |
| `npx tsx --test test/12-reconnect-pending.test.ts test/38-desktop-personal.test.ts` | 最终 51/51；输入与实际 shell、真实 ssh -G、读取分类、转发退出、令牌轮换、超时／取消、终止后手动重连、双产品身份、双目标隔离、两层连续退避 |
| `npx tsx --test test/19-tui-demo.test.ts test/13-tui-state.test.ts test/66-control-seam.test.ts test/72-on-demand-backend.test.ts test/38-desktop-main.test.ts test/38-desktop-build.test.ts test/39-desktop-recovery-guide.test.ts test/40-desktop-creation.test.ts test/41-desktop-stream.test.ts test/76-legacy-workspace-data.test.ts test/115-workflow-final-delivery.test.ts test/37-view-browser.test.ts` | 156/156；调用方与快照夹具回归 |
| `npx tsx --test test/19-tui-demo.test.ts test/66-control-seam.test.ts test/72-on-demand-backend.test.ts test/38-desktop-main.test.ts` | 退避修复后受影响调用方再次 77/77；其他上述夹具未变 |
| `npm run desktop:build` | 最终构建通过，产出 mac-arm64/Ruukoto.app |
| `codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` | 通过 |
| `git diff --check` | 通过 |

15 秒读取期限测试实际等待期限，并用忽略 SIGTERM 的读取进程验证 2 秒后 SIGKILL 与等待退出；测试不缩短生产期限。所有替身进程和 socket 均在用例结束时回收。token 轮换测试使用真实 ControlClient 和 ControlConnection，但远端控制面与 SSH 是替身，不等同服务器验收。

## 真实 Electron 证据

从仓库根执行 `node .scratch/desktop-gui/evidence/08-electron-probe.mjs`，先完成桌面构建。探针用实际 Electron 加载本轮主进程／preload／renderer 产物，使用独立临时应用档案、受管 Code 配置、本机 socket 服务端和替身 ssh，不连接日常实例或服务器；结束时清理自己的文件、进程与 socket。结果见 [verification](08-electron-verification.json)。

真实 sandbox preload 同时收到 Code 与 Personal 的快照，renderer 无 require；配置校验与脱敏通过。杀掉转发进程后收到重新认证的快照。保存新配置触发新读取后，使它阻塞并忽略 SIGTERM，连续两次退出仍等待 SIGKILL 和全部子进程结束；本地 socket 消失。遍历整个临时应用数据目录，没有出现令牌字节。

这是主进程／桥接／退出生命周期证据；未做 Personal 完整界面体验验收，也未以真实远端 SSH 代替替身。

## 独立实现审查

独立只读上下文直接读取当前方案、实现、测试和证据。首轮提出两项 P2：认证／握手断线提前换代使控制面退避固定在初始值；转发退出时状态已是 reconnecting，导致成功恢复后未归零。作者分别改为实例持有控制面退避、在 online 回调复位转发退避，并补连续故障与多轮恢复回归。

审查者亲自执行原反例，修复前均失败，修复后共享连接间隔为 21／41／81 ms（测试初始 20、上限 160），连续三次转发恢复后重启间隔为 536／537／531 ms；亲自跑两项连续断线、转发退避和双目标隔离测试 4/4。复审无未解决阻断。审查者核对了最终 51/51 与静态日志、Electron 探针源码及结果，未连接服务器。

## 外部验收与交接

工程实现和独立审查通过，状态保留 ready-for-human。真实同账户服务器的连通、令牌轮换后后台启用新值、真实 SSH master 不受影响与服务器权限错误仍不可验证；按工单前提，等待拥有者完成同账户部署。未改 tx 的账户、权限或令牌。协议 v26 要求客户端与后台同步更新，旧后台会被明确拒绝。

产品主观界面验收归后续 Personal 界面工单，本单没有新的界面布局；必要服务器环境证据仍保留，未用“不适用”跳过。未跑全量 npm run check、Linux／Node 22／CI 矩阵或真实模型；拥有者已授权本地提交，本轮实现随当前提交保存；未推送、部署或发布。
