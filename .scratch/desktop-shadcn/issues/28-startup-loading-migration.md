# 启动加载页居中与 Desktop 同步

Status: resolved

## 目标与边界

拥有者要求去掉加载页的 Ruukoto 可见标题，将剩余旋转环和「正在连接后台…」整体居中，并同步 Desktop。Demo 保留2.2秒模拟与重播；正式端接首次本地 Code 连接状态，不延迟或伪造成功，不阻挡 PA 配置和日后普通断线重连。

## 方案

Demo 与 Desktop 复用同内容的 ConnectionLoading 组合组件及样式差量，DialogTitle 仅供读屏，pending 由调用者持有，退出完成回调才解除 App 的 inert 与快捷键隔离。Demo 计时器移到 App 并保留清理；Desktop 初次 connecting 或 online 尚未装快照时保持遮罩，online 且有实例、failed、closed 或首次 reconnecting 时退出；reconnecting 已代表首轮失败，后续退避由原连接界面呈现。无新的超时、重试或业务错误类型。

独立组件初始 open=true，effect 在 pending=false 时关闭，覆盖订阅同步回放快速终态；关闭后聚焦输入或侧栏按钮。更新样式来源断言、Demo 说明、Desktop 模块说明与决策笔记。使用实际 App 的隔离 bridge 夹具覆盖延迟连接、同步快照成功、失败、重试、online 早于快照、首次关闭后的普通重连及 PA 未配置；不重启日常后台。

## 进展与交接

- 主代理为唯一写入者；startup_loading_review 独立方案审查无阻断，按实际事件顺序要求 online 与快照双条件，并在首次 reconnecting 退出。
- 分支 codex/desktop-demo-ui，HEAD 4026a2e5，保留已有未提交修改；本任务仅涉及 Demo 和 Desktop 启动展示及相应文档、检查、证据。
- 首轮实现和后续生产定位回归均已修复；原开发模式截图对生产定位的验收结论由实际构建 CSS 与原生 WKWebView 红绿测量取代。修复后 X/Y=0、遮罩宽高等于视口、原生内容中心640×360；下一步交付拥有者，重启新构建后采用。未提交、推送或重启日常进程。

## 验收与证据

工程验收通过：Demo check、根 check:static、102项 Desktop 主进程／PA／构建／样式来源／输入区定向测试、两种 Desktop 构建及签名通过。真实 IAB 核实同步终态解除 inert 并可聚焦设置、online 未有快照时6095ms仍保持加载、失败／重试／关闭后恢复入口、之后普通重连不阻挡及 PA 设置可达。startup_loading_review 亲验 test/43 与 desktop-demo-v4 共5项并审查实际源码、截图、指标，无阻断；独立浏览器不可用，交互证据由主代理取得。

产品验收通过：无可见 Ruukoto，单行旋转环与提示精确居中，Demo 与正式端展示组件和样式逐字同步。源清单、截图、数据与未覆盖环境见[验收证据](../evidence/startup-loading-migration/README.md)；日常真实后台及 PA 外网未实测。

生产定位补验通过：新增构建回归先红后绿，9项定向检查、Demo check、根静态门禁通过；MyGo／Electron 重建并校验签名。浏览器与原生 WKWebView 均从(-640,-360)恢复到(0,0)，全屏且居中，独立审查无阻断，详见[生产偏移证据](../evidence/loading-position/README.md)。首轮开发截图不能替代此项。

## Comments

- 2026-10-18：用户明确批准修改并迁移；首次连接遇到无限重试时结束遮罩，恢复既有可操作的失败界面。
- 2026-10-18：独立方案与实现审查无阻断，工程及指定外观验收完成；正式端不使用 Demo 模拟计时器。
- 2026-10-18：拥有者反馈 MyGo 加载页偏左上；生产压缩将两个 none 合并为传统 transform，默认独立 translate:-50%仍生效。原生与浏览器均跑红，窄构建回归先红后修复，使用 translate:initial 保留独立重置；loading_build_audit 只读诊断与方案审查无阻断。
