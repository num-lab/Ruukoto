# QQ 与双平台入口工程证据

对应[工单](../../issues/31-qq-owner-entry.md)，实施基线 `0ae06f457fac4c7979e793c3b888fb6fb6545008`。本目录是工程证据；拥有者明确暂未提供真实 QQ/NapCat、Telegram 测试环境，真实模型/IM 和操作者体验均待验，没有接管生产或读取旧业务档案。

## macOS

环境见 [environment](macos-environment.json)。模型为回环 HTTP/SSE 替身，OneBot 是真实回环 WebSocket，Telegram 是回环 HTTP；服务 helper 用专属临时策略/目录，不代表真实服务管理验收。成功图片用受控 fetch 返回真实 PNG 字节，证明原生视觉请求和证据重建，不代表真实 CDN 或模型识图效果。

[定向回归](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F31-qq%2Fmacos-regression.log)执行以下 16 文件，235 项中 234 通过、0 失败、1 项仅 Linux 适用（服务核实 HTTP 的 sudo/慢停止用例），18.6 秒：

```sh
RUN_MODEL_CHECK=0 npx tsx --test test/personal-qq.test.ts test/personal-media.test.ts test/personal-work-controls.test.ts test/personal-mcp-controls.test.ts test/personal-tools-controls.test.ts test/personal-browser-integration.test.ts test/personal-telegram-permissions.test.ts test/personal-telegram.test.ts test/personal-reports.test.ts test/personal-work-notes.test.ts test/26-qq.test.ts test/40-qq-private.test.ts test/41-qq-private-scope.test.ts test/38-telegram-owner.test.ts test/89-im-entries.test.ts test/personal-cli.test.ts
```

随后按最终受影响内容执行 QQ/媒体两个文件，36/36 通过，结果见 [final QQ/media](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F31-qq%2Fmacos-final-qq-media.log)。覆盖 QQ 平台时间快60秒的旧积压、配对消息身份重投、换代重置默认权限、成功 get_image 图片请求、收件失败断线记录，以及最新测试清理。其余已经通过且未受这些修改影响的用例不重复运行。最后补查重复 poll 被拒绝且首循环仍在线的[单用例](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F31-qq%2Fmacos-duplicate-poll.log)，独立审查者同例1/1通过。

`npm run check:static` 通过，原始输出见 [static](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F31-qq%2Fstatic.log)。最终只删除未使用的 type 和修改测试后，补跑对应 ESLint 与根 `npx tsc --noEmit`。没有跑全仓 `npm run check`，改动不涉及依赖/构建/正式入口，未用全量代替定向证据。

最终源码和常驻文档由 [SHA-256 清单](implementation.sha256)标识，不含本证据或工单自身。`.scratch` 的链接、段落、状态和末尾换行另用仓库 Markdown 解析器显式核对，见 [检查结果](scratch-doc-check.json)。

## Linux

独立上下文通过 `ssh tx` 在专属目录以最终原 TypeScript 和原嵌套依赖运行，源码592/592与本机最终内容一致。`personal-qq + personal-cli` 为49/49，`26/40/41/89` 为17/17，合计66/66、零跳过；本机跳过的 sudo/慢停止 HTTP 用例在此实际执行。环境、完整命令、原始日志、依赖指纹、准备失败及重试、归档核对和专属目录清理见[Linux 证据](linux/README.md)。共享调用方不受最后个人 loop 修正影响，不重复重跑；个人测试使用最终内容。全部是回环模型/IM及 helper/sudo 桩，不声称真实系统服务或真实 IM 通过。

## 独立审查

`final_qq_review` 直接读取规格、实际未提交差异和相连调用方，审查全部 QQ 配对/传输、共用收件/报告、来源与控制隔离、权限/长期授权和恢复反链，结论无未解决工程阻断。亲跑两组控制/QQ/TG/报告/媒体用例；发现的配对占位同号、平台时间边界、候选账号来源均修复并按最窄用例复验。额外独立进程模拟账号 A→B→A，仅在 B 收到随机短语，现实现拒绝并不落配置。最后收件提交丢答与发送故障矩阵 7/7，通过 `failed/1200` 未知且重启不重发。

共享 OneBot 修复另由 `qq_transport_audit` 在独立副本执行 26/40/95 共18/18，并撤掉修复，确认新增1200断言失败，再恢复修复；不是仅凭绿灯推断能捕获回归。来源实现作者不把自身审查当独立通过；完整来源改动由上述最终审查覆盖。

## 平台限制与待验

OneBot 正向 WebSocket 无入站 ACK 和离线补拉；只有本地提交的消息受稳定键保护，连接缺口持久可查。新 QQ 发送仅在已知未发送且离线时延后；没有可核实的结构化 QQ 限流契约时保留未知，不按文案猜重试。Telegram 明确429回归仍通过。协议来源及选择见[决定](../../../../.agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md)。

真实 QQ/Telegram 各自的文字、图片、审批、取消和最终回报，以及真实模型、回复引用/平台限流和操作者体验未验证。新 QQ 没有另写一套发送后 SIGKILL 测试，共用发送阶段沿已通过的 Telegram/报告强杀用例，新平台另验证丢答/异步/1200和断线；最终真实综合验收仍须覆盖 QQ 平台窗口。A2/A3/A5/A6/A10/A11 不因此标成完整通过。
