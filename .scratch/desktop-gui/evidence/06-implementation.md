# 审批与通知实现证据

日期：2026-10-15。环境：macOS、Node v24.15.0、Electron 44.7.2。工单见[审批卡片、系统通知与 Dock 角标](../issues/06-approvals-and-notifications.md)。最终工作基点为 `0b7fe7e`；接手时已有的 Personal SSH 修订已独立提交，本单未撤销或覆盖它。

## 实现

共享 view 的待审批选择器只接受 pending、任务非终态且权限版本一致的审批，TUI、桌面渲染和主进程计数采用同一规则。模式切换失败专用事件只对非终态任务投影中断、补结束时间并保留原失败原因；终态常量从无 Node 的 core 模块提供。浏览器夹具补齐有效权限版本，保留原打包、全局检查与 VM 验证。

两个目标共用审批卡片，展示操作范围、目标、审查状态和转人工原因，完整参数按实际 UTF-8 返回偏移续读。决定绑定目标、实例、审批和展示版本；所有 outcome 分流后均不自动重发。未知结果查询原审批或等待同实例快照；新快照淘汰旧请求，新权限版本失效旧参数，查询失败提供在线刷新入口。

主进程持有两个目标的 view，按实例维护审批、终态与观察中任务基线。首次快照及其截止点内的历史补发静默，缓冲 live 照常通知；前台记已见、取消不通知。快照缺失的观察中任务经 get_task 核实，失败留待下次快照。角标取两个当前审批集合之和。原生通知同步异常与角标异常只报告诊断，不打断控制面事件；通知点击经目标订阅传递实例和导航，成功消费意图并保留右栏所需的子会话与任务选择。

Personal 仅开放本单审批与 get_task 核实，其他业务仍待完整界面。同步窗口允许通知需要的只读 get_task，仍拒绝审批写入。新增代码无依赖或协议变更；desktop、view、core、架构依赖说明与原提案笔记已同步。

## 工程验证

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsx --test test/38-desktop-main.test.ts` | 最终 51/51；双目标基线、汇总、断线补通知、无补发恢复、旧代次、前台、取消、审批各类 outcome、版本与参数、新实例静默和原生异常 |
| 桌面及共享投影回归 | main、build、recovery-guide、creation、stream、13、34、36、37 九个文件共 128/128；随后新增的原生同步异常与真实 21 条历史用例已在最终 main 51/51 中通过 |
| `npx tsx --test test/38-desktop-personal.test.ts` | 25/25；包括同步快照回调内 get_task 成功、审批写入仍 not_sent 的窄回归 |
| 真实 Runtime / ControlServer / ControlConnection | 在线另一客户端普通中断、可控停止失败的模式切换都不发解决事件；共享选择器移除审批、角标归零、中断通知一次，失败原因保留。真实历史握手含 20 个快照终态和 21 个补发完成事件，经真实 ControlConnection 换实例仍静默，online 前的新 live 通知一次 |
| TUI 调用方 | 独立审查执行 14/19 为 38/39；实际审批批准、拒绝、抢先处理均通过。66 的审批断线与丢答 2/2 |
| 既有 TUI 失败 | `test/14-tui-app.test.ts` 的无效 `--session` 用例，在已退出关闭连接后仍等 online 而超时。当前代码单独复现；审查者在隔离的 HEAD archive 基线副本复现相同失败，未纳入本单修改，也未记为通过 |
| 静态检查 | 最终 `npm run check:static` 通过：lint、全 workspace/foundation 类型、笔记和文档门禁；`git diff --check` 通过 |
| 构建 | 初轮 `npm run desktop:build` 通过；最终源码的标准重跑卡在 Electron 下载收尾后主动停止，改用已安装的同版二进制：`npm run desktop:build --workspace=@ruukoto/desktop -- --config.electronDist=/Users/eitrous/Developer/ruukoto/node_modules/electron/dist` 通过；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 通过，未改仓库构建配置 |

最终 app.asar SHA-256：`f75246a01dac9c16e09cd2373e709a4bfcbbb3cba80ef86fbe0c4056da685a89`。真实 GUI 操作针对此前构建的同一 Code 审批交互；末轮增加原生异常隔离并收窄 Personal 展示，分别由定向回归与独立增量复审覆盖，未声称重新完成原生通知送达。

## 独立实现审查

两个独立上下文分别负责审批／共享投影和通知／IPC／导航，直接核对工单、规格、源码、测试、文档与笔记并运行所需检查。审查发现的旧参数沿新版本批准、在线未知无法主动刷新、导航重复应用、浏览器夹具缺权限版本、Personal 同步查询回归缺口均已修复并复验。最后原生异常隔离与真实历史增量复审 8/8。结论：实现审查通过，无未解决的实现阻断；既有 TUI 基线失败及下列外部缺口继续保留。

## 真实 Electron

[探针](06-electron-probe.mts)启动临时真实 Runtime 与 ControlServer、本地模型替身、真实已构建的 Electron 主进程和 sandbox preload；独立控制面连接运行 TUI ViewState。全部 GUI 决定通过 CUA 的原生可访问性按钮执行。它验证真实 Electron 接线，不等同于最终签名应用的原生系统通知验收。结构化结果见[观测记录](06-electron/verification.json)、[后台决定](06-electron/actions.json)和[诊断](06-electron/stderr.log)。

- CUA 观察到范围、工作目录、权限版本与初始禁用的决定按钮；读取完整中文与 emoji 参数后，批准第一项、拒绝第二项，卡片分别消失。真实后台两任务均 completed，审批分别 approved 且已消费、rejected 且未消费；TUI 投影同步清除待审批。
- 第三项审批在实时事件后出现，独立控制面客户端拒绝后卡片消失。观察接口有缓存／调度延迟，本轮不以读取时间声称渲染时延指标；未确认有投影缺陷，另有实时投影与通知异常隔离回归。
- 真实原生 Dock setBadge 随待审批写入 `1` 和空值。后台审批及任务完成调用真实 Notification.show，macOS 返回 `UNErrorDomain error 1`，应用诊断可见；通知实际送达与原生点击未通过，未以人工 emit click 冒充验收。
- 临时 Electron、后台、模型服务、控制面连接与目录已清理，没有修改日常档案、系统通知设置或服务器账户。

## 待验收

按[开发流程](../../../.agents/skills/development-workflow/SKILL.md)：“必要真实环境验证缺失属于证据缺口，保留待验收及恢复条件”。本单保留 ready-for-human：恢复 macOS 对真实应用的通知送达后，补后台通知、原生点击定位、聚焦及前台抑制的实际操作；07 完成后补 SubAgent 右栏定位，08 的同账户服务器前提与 09 完成后补 Personal 真实 SSH 通知及点击。两个替身目标只能证明隔离和汇总，不代替 Personal 外部验收。

未运行全量 `npm run check`、Linux／Node 22 或真实模型。范围沿用已确认方案，没有新增待拍板的产品取舍；上述必需环境验收尚未完成，不能把产品验收标为通过。
