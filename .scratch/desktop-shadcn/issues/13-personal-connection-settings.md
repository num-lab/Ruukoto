# PA 远程连接设置

Status: ready-for-human

## 目标与范围

拥有者在 2026-10-17 继续 GUI demo 设计，要求给设置界面增加远程连接 PA 的设置。本轮只改可变 demo；保留上一轮未提交的 Ruukoto 主会话与右栏限制，不恢复运行目标选择，不修改正式 Desktop、后台或冻结稿。

## 方案

在现有设置的左侧类别加入「PA 远程连接」，右侧提供 SSH 主机别名、远端控制目录与「保存配置」。字段依据正式后台 personal-config.ts 的 host、controlDir；主机初始为空，不预填用户服务器，控制目录默认 /var/lib/ruukoto/control。用户名、端口、密钥仍由本机 SSH 配置管理，不另加凭据或连接方式。

复用 shadcn Input、Button、Tabs，表单按 Field 组合。浏览器原生 required／pattern 阻止空值和不符合后台字符范围的输入；表单保存只更新 App 内存配置并显示模拟保存反馈，关闭设置或换类别后重新打开读取已保存值，未保存的编辑不应用。页面明确提示仅本次演示保存且不建立真实 SSH 连接，不伪造在线状态或测试连接结果。

影响：demo app.tsx、必要的表单组件、既有 render 自检、README、当前工单与[决策笔记](../../../.agents/notes/implemented/feature/2026-10-17-demo-personal-connection-settings.md)。不新增 npm 依赖，不读取本机 SSH 配置，不联网或运行 SSH，不扩展 PA 会话能力。

## 验收

Demo check、全仓 check:static 和 diff 检查；窄回归覆盖表单两字段、默认值与原生校验约束。浏览器检查从 Code 和 PA 均可进入，空值／非法别名／相对目录不能保存，合法值保存后关闭重开与切换类别仍保留、未保存编辑不应用，保存不改主会话或右栏，明暗与窄窗可用。独立方案审查、实现及证据审查分开记录；观感待拥有者审阅。

## 进展

根会话为唯一写入者。pa_demo_audit 已独立核对需求、demo 与正式配置源码，方案审查通过，无阻断；特别核对浏览器 v 标志的 pattern 转义与原生有效性。实现与证据复核通过，无未解决实现阻断。pa_demo_audit 直接读取最终源码、回归、说明、明暗截图、三个 AX 快照与九条浏览器校验结果；亲自重跑 tsc --noEmit、node scripts/check-render.mjs、git diff --check，均通过。README 保存时机与模态窗内 role=status 反馈已核对一致；独立审查没有重复浏览器交互、全仓静态与构建，沿用实施者执行证据。

工程检查通过：demo check、全仓 check:static 与 diff 检查；最后仅修改 demo 内保存反馈与说明，随后重跑 demo check 通过。浏览器九个非法输入、合法保存、关闭／换类别丢弃编辑、从 Code 与 PA 进入、Enter 保存、PA 草稿和右栏隔离、当前视口明暗布局均通过，[证据](../evidence/personal-connection-settings/README.md)持有原始结果与截图。

下一步：拥有者审阅观感与小于540px的更窄布局；当前IAB未提供调整视口能力，该项保留人工验收，不记通过。真实 PA 连接、刷新持久化与正式迁移不在本轮范围。
