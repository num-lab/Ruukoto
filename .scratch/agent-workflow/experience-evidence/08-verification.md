# 工单 08 实现与验证交接

2026-10-14；基点 `70b2845`，macOS arm64 / Node 24.15.0，工作区接手时干净，工程验收时为未提交快照。根工作区单写入，后台展示字段、回执查询与 PTY 在独立工作副本实现后汇总。独立审查见[实现审查](../experience-review-08.md)，最终范围见[输入清单](08-inputs.sha256)。日志文本副本仅规范行尾空白和唯一结尾换行；修前 PTY 压缩原件保留原字节。

## 行为与边界

两产品共享 `/workflow` 逐层侧栏：当前活动及最近十项结果、历史、定义选择启动、步骤/日志/业务问题、暂停/恢复/取消与预算。宽屏同时聊天，窄屏保持所在层与选择，Tab 切焦点、Esc 返回；退出不取消运行。固定名称、显式说明、含毫秒时间与展示序号区分对象，八种状态及停止核实、效果未知、回报分别呈现。原请求在发送前保存，断线和重启只读核实，明确未接收后由选择原键重试，foreign 和坏记录保留。

临时脚本启动新增必填标题，命名定义固定所选名称；模型工具与机器 CLI 同步，参数隐私不自动进入列表说明。schema 41/协议 25 拒绝旧档案及客户端，不自动迁移；两方向导入继续明确拒绝含工作流执行记录的源实例，新字段不绕过原约束。等待机制、IM 渐进交互及子 Agent shell 问题不在本单修改范围。

## 检查与证据

| 内容与环境 | 结果 | 对应范围 |
| --- | --- | --- |
| `npx tsx --test test/12-reconnect-pending.test.ts test/108-workflow-import.test.ts test/114-workflow-owner-input.test.ts test/118-workflow-entries.test.ts test/120-workflow-cli.test.ts test/125-agent-wait-core.test.ts test/125-agent-wait-view.test.ts test/126-workflow-sidebar.test.ts` | [87/87](08-backend-stage.log)，无跳过 | 汇总后台与恢复阶段；随后追加的重开及键路由回归不冒充已包含。 |
| `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/65-slash-commands.test.ts test/126-workflow-sidebar.test.ts` | [93/93](08-tui-stage.log)，无跳过 | 启动→回答→暂停→预算→恢复→取消、聊天共存、缩放、历史和故障恢复；早于最终搜索/release 路由返工。 |
| `npx tsx --test test/126-workflow-sidebar.test.ts test/125-agent-wait-core.test.ts` | [48/48](08-sidebar-core.log)，无跳过 | 最终重开查询、固定等待标签、侧栏长列表/日志及 28 项恢复/状态用例。 |
| 独立 worktree 的 `npx tsx --test test/15-tui-pty.test.ts` | [4/4](08-pty-stage.log)，无跳过 | 三项真实后台/CLI/PTY 与一项 FakeTerminal 输入边界；完整选择启动，日志翻页、140→70→140 缩放、Tab 聊天及 Esc 退出，后台保持待回答；早于最终更窄的视口路由。 |
| 隔离撤去分页键修复，再运行同一 PTY 新用例 | [修前失败原件](08-pty-before-fix.log.gz) | 旧路由会把 PageDown 送到聊天，不能读长日志；恢复后同用例通过，未放宽断言。 |
| `npx tsx --test test/126-workflow-sidebar.test.ts` | [30/30](08-sidebar-final.log)，无跳过 | 最终原键/版本/实例恢复、导航与八状态；新增两项业务回答约束覆盖输入和选项，错误保留在当前层且零发送。另一上下文亲验这两项 2/2。 |
| `npx tsx --test --test-name-pattern='视口键' test/14-tui-app.test.ts` | [3/3](08-viewport-final.log)，无跳过 | 搜索获焦仍操作聊天视口，Kitty 释放帧不滚动聊天或侧栏；永久回归同时纳入最终全量。 |
| 独立 worktree 最终 `npx tsx --test test/15-tui-pty.test.ts` | [4/4](08-pty-final.log)，无跳过 | 三项真实 PTY 加一项 FakeTerminal；最终生产键路由及驱动收尾修复。其后只将 TS 失败退出码声明改为可空，驱动逻辑未变，最终全量再次覆盖。 |
| PTY 收尾探针 | [真实 macOS](08-pty-cleanup-probe.log)与[内存替身](08-pty-memory-probe.log)通过 | 真实僵尸组 `EPERM`→正常退出 100/100、`ESRCH`→正常退出、非零与活进程拒绝；替身验证其他异常、单进程停止拒绝及最终等待超时均保留错误和原输出。不是产品模型或 IM 证据。 |
| 根工作区 `npm run check` | [完整日志](08-full-check-final.log.gz)，退出 0 | 构建、lint、typecheck、笔记及文档门禁通过；macOS 独占验证 38/38，应用测试 1446 项中 1441 通过、5 项真实模型门控跳过，基础验证 10 项中 9 通过、1 项真实模型门控跳过；无失败和取消。包含最后两项业务回答约束及全部新增键盘用例。 |

此前两次完整检查均未记通过：[第一次](08-full-check-before-fixture.log.gz)唯一失败是等待标签断言仍写死旧展示文案，已更新为固定名称、展示序号与时间；[第二次](08-full-check-before-pty-cleanup.log.gz)唯一失败是旧 80×24 PTY 驱动清理阶段遇到 macOS 僵尸组 `EPERM`，尚未打印 JSON，产品断言未失败。驱动现仅在原六秒收尾预算内确认退出码为零后接受退出竞争；真正的非零、超时或清理异常保留失败、终端全文与分段输出。独立复核和负例通过，再运行上表最终全量成功，未放宽产品断言。

交接文档落盘后再次运行 [`npm run check:static`](08-static-final.log) 通过。最后按实际汇总范围运行 `npm run change-scope -- --base 70b2845`；笔记锚点检查无悬空引用。[输入清单](08-inputs.sha256)记录有效要求、当前改动及本单日志的 SHA-256，不含清单自身；被移走的 proposed 笔记由 Git 差异保留删除关系，不改写既有历史哈希。拥有者可据此复查本次未提交快照。

## 产品与外部环境

2026-10-14 拥有者在本对话确认“已完成人工验收”，[工单 08](../issues/08-workflow-sidebar.md)转为 resolved；产品结论来自该人工确认，工程检查、独立源码审查和 PTY 不替代主观体验验收。具体产品入口与逐路径结果未提供，不扩展为真实模型、IM 原绑定送达、Linux 或 CI 矩阵通过；这些项目本轮未运行，联合验收由 11 持有，不复用 07/10 旧证据冒充本单通过。本次仅更新状态、交接和对应输入哈希，产品代码及既有测试日志不变。
