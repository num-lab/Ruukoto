# 删除桌面浏览器预览的路径名称黑名单

Status: resolved

## 目标与边界

拥有者于 2026-10-25 在了解黑名单用途和删除影响后明确要求「删除，这些都不在桌面浏览器预览的职责范围内」。删除 `browser-documents.ts` 的 `sensitive()` 名称判断，直接打开与页面资源请求采用一致行为。现有目录范围、链接、userData、格式与预算约束不在本次删除范围。

## 方案

删除名称谓词及 `protect()` 中对应条件，收窄剩余错误文案。将原黑名单拒绝断言改为实际 HTTP 读取和直接打开成功的回归，覆盖文件名、目录名及 `.env` 前缀误拦截，保留其余拒绝断言。同步桌面模块文档，新建 simplification 决策笔记并与旧决定互链。调用方、协议、配置和导出无需修改。

## 进展与交接

接手基点为 `274a8ea5dbc1246777b32dcd83d140331a8cad77`，接手时工作区干净。根代理为唯一写入者，审查者只读。已删除名称判断并同步测试与文档，定向测试、静态检查和独立实现复审均通过，无待办或阻塞；拥有者已授权提交，未推送。职责取舍见[决策笔记](../../../.agents/notes/implemented/simplification/2026-10-25-browser-path-names.md)。

## 验收与证据

验收要求：原黑名单中的普通文件能直接打开并作为同目录资源读取；越界、链接和受保护目录仍被拒绝。`npx tsx --test test/desktop-browser-documents.test.ts` 与 `npm run check:static` 均通过，独立审查者核实改动范围和行为回归。工程验收通过；产品验收不适用，拥有者已确认职责取舍，界面和原生桥接没有变化；未运行全量测试、真实模型或原生显示验收。

2026-10-25 独立审查者 `browser_blacklist_review` 完成方案和实现审查，均无阻断。实现审查对象为上述基点的四个已跟踪文件差异与本工单、新决策笔记全文；审查后仅补全本工单验证结果。审查者亲跑 `npx tsx --test --test-name-pattern='本地预览不按路径名称|资源不能越界' test/desktop-browser-documents.test.ts`，2/2 通过，核实实际 HTTP 和直接打开行为及剩余拒绝约束。

作者在 macOS arm64 / Node 24.15.0 先运行新回归的名称过滤用例，旧实现对 `.env.local` 返回 403 而非预期 200，确认用例会捕获旧限制；修改后 `npx tsx --test test/desktop-browser-documents.test.ts` 10/10 通过，包含真实 loopback HTTP 读取、直接打开和剩余拒绝约束。`git diff --check` 与 `npm run check:static` 通过，后者涵盖 lint、全工作区类型检查、笔记及文档检查。
