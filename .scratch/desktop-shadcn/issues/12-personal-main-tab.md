# Ruukoto 主会话入口

Status: ready-for-human

## 目标与边界

拥有者在 2026-10-17 要求先提交冷启动分析，再回到 GUI 设计：删除设置中的运行目标，在工作区列表上方增加 Ruukoto 按钮，点击打开标签页，中间显示 Personal 的单一主会话，右栏可展开但不显示差异与文件树。冷启动分析已提交为 53fad80。本轮沿用可变 demo 优先的设计流程，不修改正式 Desktop、后台、冻结稿或真实连接；不编造 Personal 对话样例。

## 方案

1. 删除全局目标切换、运行目标设置及原 Personal SSH 占位。工作区列表常驻，在其标题上方添加同风格 Ruukoto 行。
2. 独立保存一个固定身份与标题 Ruukoto 的 Personal 主会话，复用顶部标签、消息流与输入框。重复点击只聚焦；关闭标签再打开保留历史、草稿、模型、附件及在途输入结果。Personal 不混入工作区和筛选，也不提供新建第二个主会话的入口。
3. 共用右栏开关与按会话隔离的标签状态。Personal 右栏保留浏览器与 SubAgent 入口，排除文件树和差异，文件与差异打开函数也检查工作区／目标，防止演示场景或旧状态绕过。Code 的差异、文件树与文件预览继续工作。
4. Personal 复用普通空态，不增加聊天文案。发送沿既有模拟提交，回复仅保留通用模拟说明；Code 的工具／差异演示不套入 Personal。状态和提交定时器按固定 session 身份更新，切换标签不串话。

影响：demo 的 app.tsx、demo-data.ts、style.css、check-render.mjs 与 README；必要回归及本工单／决策笔记。沿用已有 shadcn Button、Tabs、Dialog，不新增依赖。决定见[笔记](../../../.agents/notes/implemented/feature/2026-10-17-demo-personal-main-tab.md)。

## 进展与交接

- 当前阶段：实施、文档、工程检查、浏览器交互与独立实现／证据审查完成，无未解决阻断；等待拥有者审阅观感。
- 当前内容：基点 53fad80，只有可变 demo、回归自检、README 和本轮记录；GUI 改动暂不提交。
- 下一步：拥有者在当前 demo 审阅界面；后续提交或迁移正式 Desktop 需按新指示继续。
- 阻塞：无。

## 验收与证据

工程检查通过：demo check（含新增 PA 渲染／提交断言）与全仓 check:static、git diff --check。真实浏览器覆盖入口、设置删除、唯一标签、关闭重开保留草稿与历史、模型隔离、跨标签延迟发送、PA 右栏与快捷键、Working 无 Code 样例、Code 差异／文件树／预览、明暗和窄栏；[记录与截图](../evidence/personal-main-tab/README.md)附环境和步骤。

产品验收待拥有者审阅布局与观感；可观察交互已由浏览器验收。真实 Personal 连接、持久化和正式 Desktop 迁移不在本轮范围。

方案审查：pa_demo_audit 独立审查通过，无阻断。实现与证据审查：pa_demo_audit 直接读取最终源码、测试、README、实施笔记、三张截图和全部 AX 快照，核对入口、唯一主会话、提交隔离、右栏过滤与 Code 回归；亲自执行 tsc --noEmit、node scripts/check-render.mjs、git diff --check，均通过，无未解决阻断。未另运行浏览器、全仓静态或构建，沿用实施者实际执行证据；真实 Personal、持久化和正式 Desktop 未验证且不在本轮范围。

## Comments

2026-10-17：Personal 当前只有目标切换后的 SSH 占位，没有对话 fixture；本轮以固定空主会话建立设计交互，避免增加未要求内容。
