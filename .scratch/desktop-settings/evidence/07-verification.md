# 07 Personal SSH 设置与维护验收

日期：2026-10-21。实施基点 `f36f7671904555a27883cea173493d1df16b5fbd`，开始时工作区干净；01、06 均已 resolved，07 的方案和产品范围已有拥有者批准。代码与文档完成，独立工程审查无未解决阻断；真实固定 systemd 与双壳产品体验保留待验收，不能以模拟通过结单。

## 已交付与调用关系

- `personal-settings.json` 独立保存 SSH/档案/程序/生命周期；旧 `personal.json` 与聊天控制器保持原归属。连接用途用现有 Tabs/Field/Select 分步选择，提供检测、保存本机连接和核实原档案/服务。
- 现有 Electron/MyGo `request` 共用 DesktopHost 的 `desktop_personal_management_config_read/save/detect` 与 `desktop_personal_settings_read/request/apply/restore/finish`。没有新增 preload 方法或 Go 配置客户端；08 可直接消费原 Host，三类 Personal 管理页面仍由 08 交付。
- `PersonalSettingsController` 先核维护身份及已有档案，避免错目录触发通用 settings 初始化；机器 JSON 走 stdin，在线读经转发的认证 HTTP。固定 SSH 参数、限额、UTF-8、每次读取 token、代次取消、进程回收与错误分类有回归。
- `ruukoto maintenance` 只提供 inspect/stop/start；CLI 原环境未知与开发受管只读。固定系统级后台核账户、入口、档案、MainPID/原进程身份、精确 sudo 授权与无强杀策略。`serve --directory` 将档案固定到有效 ExecStart，维护不读取 EnvironmentFile 证明凭据。
- 显式单项停存启沿在线凭据/未决预检 → 停原监督服务 → 退出/锁核实 → 原设置持锁保存 → 原方式启动 → 读回修订。private journal 保存原关联和阶段，丢答只查询；保存成功后启动/记录失败仍保留已保存事实，恢复不重存，未决时不丢掉原连接。
- 部署模板仅为后台增加 `SendSIGKILL=no`、`TimeoutStopFailureMode=terminate` 与固定档案参数，独立 sudoers 只列固定 start/stop。现有 helper 的后台禁令和其他服务停止策略未放宽。桌面、Personal、产品、部署、usage、README、development 与最小检查说明同步。

## 自动化与构建

各行是独立执行结果，存在覆盖重叠，不累加为唯一用例总数。

| 命令 | 实际结果与覆盖 |
| --- | --- |
| `npm run setup` | 通过，应用项目依赖补丁；没有修改锁文件 |
| `npx tsx --test test/38-desktop-personal.test.ts test/desktop-mygo.test.ts test/personal-settings.test.ts test/desktop-personal-settings.test.ts test/personal-maintenance.test.ts test/desktop-settings.test.ts` | 汇总阶段 82/82 通过；后续修改由下列窄回归重新覆盖 |
| `npx tsx --test test/desktop-personal-settings.test.ts test/personal-maintenance.test.ts test/desktop-mygo.test.ts` | 31/31 通过，含恢复/脱敏/版本/身份/注入/限额/停止超时/原服务校验及双桥 |
| `npx tsx --test test/desktop-personal-settings.test.ts` | 最终 18/18 通过；补保存后内部错误、journal 写失败仍已保存、退出回收、原连接保护、已有档案先核与启动失败显式恢复 |
| `npx tsx --test test/desktop-settings.test.ts` | 最终 13/13 通过，含用途页签、对应面板和字段标签 |
| `npx tsx --test test/personal-entry.test.ts test/71-product-entry.test.ts test/32-dev.test.ts test/99-workspace-boundaries.test.ts test/personal-cli.test.ts test/38-desktop-main.test.ts test/38-desktop-build.test.ts test/43-desktop-demo.test.ts test/desktop-settings.test.ts` | 162 通过、1 跳过；跳过为既有 Linux sudo 服务 HTTP 用例，不能算通过 |
| `npm run check:static` | lint、全部 workspace/root/foundation 类型、notes 与 docs 门禁通过 |
| `npm run build` | 通过；正式包包含 maintenance 与 CLI 入口改动 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 两壳构建通过；不等于已启动真实原生应用验收 |
| `cd apps/desktop/mygo && go test -race ./...` | 通过（缓存） |
| 两壳 `codesign --verify --deep --strict`、`git diff --check` | 通过 |

前期 300ms 的 fake SSH 统一超时预算在忙机中误伤正常读取，已只在夹具增加到 1500ms，保留真正挂起分支的超时断言。合入测试预算补丁一度撤回 TimeoutStopFailureMode 夹具，超时测试未进入 stop 而挂起；该批终止，恢复字段及拒绝负例、增加测试总期限后，31/31 和独立复跑通过。首次类型门禁也查出负例对象数组推断含 undefined，已用明确 `Record<string,string>[]` 修正。失败与挂起批次未记通过，生产停止保护没有被撤回。

## 独立审查

上下文 `/root/connection_audit` 直接读取工单、规格、实际源码、调用方、部署与文档，执行旧 Personal SSH 27/27、新两文件最终修复后 25/25、设置 SSR 13/13 及 diff 检查。作者修复了审查发现的保存后错误误报拒绝/未保存、pending 时原连接丢失、UTF-8 跨块损坏、尾斜杠/字段定位、journal 字段校验与回执后本机记录失败，以及 systemd abort 超时可发非优雅信号的问题。最后的已有档案先核与启动拒绝恢复再次独立亲跑当前 Host 18/18，结论无新增阻断；按最后建议，将入口顺序负例同时覆盖 read/probe，两入口均执行到。

## 浏览器模拟验证

使用 Playwright、真实 React/shadcn 与模拟 Host 渲染实际 SettingsDialog；本机 Vite 临时入口无真实后台调用。430×420 视口，内容面板 clientWidth=scrollWidth=268，clientHeight=370、scrollHeight=1065，支持纵向滚动而没有横向溢出；用途页签横排并有对应 tabpanel。实测编辑 SSH 草稿后切用途弹出继续编辑/放弃/保存三选，放弃后显示独立旧连接；聚焦旧用途页签后 ArrowLeft 返回管理。明暗均可读，底部操作可滚入，最终 fixture 无浏览器运行错误。窄窗截图：[浅色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2F07-personal-light-430.png)、[深色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2F07-personal-dark-430.png)、[底部操作](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2F07-personal-light-bottom-430.png)。这些是合成 bridge，不能替代原生两壳、SSH 或真实服务验收。

## Linux 与待验收项

[Linux 记录](07-linux.md)保存 exact commands、版本、原 JSON 和源码时点。真实 CLI detached 在另一个 SSH 连接核实同一 PID/boot/start 身份仍存续，未知原环境仍只读；仅停止本轮临时档案，原身份退出且锁可得，无本次残留后台。最终远端维护源码与模板又在 Linux 跑 9/9 通过，systemd 部分仍用受控替身；依赖只读复用同版已有安装，干净 npm 安装遇磁盘不足，不声称干净安装通过。

真实固定 `ruukoto-backend.service` 在 tx 是旧入口、异账户且仍 `SendSIGKILL=yes`，没有对它发启停，也没有安装 unit/sudoers 或用其他名称冒充固定单元验收。恢复验收条件：管理员准备同账户、新 durable 固定入口/档案、精确授权、无超时强杀的隔离固定部署；再验证实际服务环境、全程停存启、各阶段断线恢复和退出无自有残留。拥有者还需在真实 Electron/MyGo 核对连接向导的明暗、窄窗、键盘与恢复体验。07 保留 ready-for-human；08 的页面工程可继续消费本 Host，整体产品验收仍由 09 汇总。
