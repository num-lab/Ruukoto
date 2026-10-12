# 工作流定义库与交互入口

Status: planning

## 目标与边界

落实[规格 A2、A6、A8、A9、A10](../spec.md)，依[实施计划第七节](../implementation-plan.md#七定义与交互入口)开放命名保存、带参运行和工作流控制。不建设流程编辑器或插件分发系统。

## 实施与交付

1. 在实例 agentDir 的 workflows 下管理定义，保存/加载固定内容版本，已引用版本与历史保留；路径、符号链接、大小和语法错误明确拒绝。
2. 为模型装配有明确编写说明的发起/查询/保存/取消工具，身份由宿主注入；模型不能修改运行授权或提高预算。
3. 接入 CLI/TUI 的定义列表与详情、运行列表与步骤状态、阶段日志、人工答复、暂停/恢复/取消；可读错误提供安全下一步，不泄露凭据。
4. IM 提供身份核实后的明确控制命令，绑定运行和问题；来源不符、定位歧义、引用正文与伪造命令不改变运行。
5. 覆盖模型自主启动与用户显式启动、参数化复用、定义更新不改变原运行，以及多个运行与普通聊天并存。

落点包括 agent 宿主工具族、runtime 定义加载与控制、control、packages/tui/src/cli.ts 与 tui、channels IM 入口。共享工具按包 exports 接线，产品差异留在各 app 能力声明。

## 验收与交接

依赖 [05](05-owner-input-and-delivery.md)。新入口有定向用例；回归 `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/33-config-tui.test.ts`、`test/66-control-seam.test.ts` 与 `npm run check:static`。

命令与故障处理同步 README、docs/usage.md、docs/development.md、pre-push-checks 及对应模块文档；更新架构模块地图和 CONTEXT.md 中已确认的领域术语。产品体验在 07 验收，目前没有 UI 或命令实现。
