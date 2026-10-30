# Code MCP 实现与验收记录

日期：2026-10-21。基点 `86709fa6`；01、02 已交付，03 按已批准规格实施。拥有者已要求将本次实现提交到当前分支，未授权推送；所有写入测试使用临时隔离档案，没有修改日常真实配置。

## 实际交付

设置 → MCP → Code 可在没有打开会话时选择工作区与原配置来源，后台按每页 50、上限 100 个候选列出工作区自身及组织映射旧会话的原项目名称和服务数；当前普通会话默认原来源，无会话默认工作区自身。页面始终显示作用范围，滚动时保留该文字。多个原项目的同名服务分别读写。

服务支持新增、编辑、启停、删除、连接与发现检查；新服务先保存禁用草稿，再发现工具、逐项选择允许项和 read/write/unknown 声明、保存并显式启用。新允许项默认 unknown，不信任远端只读注解。发现仅初始化与 tools/list，不执行业务工具；没有增加 stdio、OAuth 或业务试调用。

凭据可显式选择匿名、保留现有引用、选择已有绑定或保存新 Bearer 令牌。新绑定首次落盘即限定原来源与 MCP 操作，核对实际 host、mcp 用途及 authorization 头；服务保存失败或取消仍无法用于通用 HTTP 或其他来源。列表只有元数据和引用，仍有服务引用时拒绝清理；失效引用不降为匿名。省略引用保留，null 才清除。

更新同时提交读取到的 service_id 与 expected_version，在配置事务内核实身份，避免同名删除重建的版本回绕覆盖；原服务删除后重复保存也不会变成新增。冲突保留草稿与可比较当前值，新增同名冲突必须显式选择当前服务才变成更新；放弃草稿恢复读回的当前值。应答丢失只保留原目标及操作元数据，秘密输入立即清空，不重发写入；读回失败继续待核实。启停配置与事件同事务，停用不承诺取消已发出的远端调用。

同步文档：desktop、control、agent-tools、runtime、core 及 usage。理由、备选与既有笔记审计见[决策笔记](../../../.agents/notes/implemented/feature/2026-10-21-code-mcp-settings.md)。

## 工程检查

| 检查 | 最终结果 |
| --- | --- |
| `npx tsx --test test/24-mcp.test.ts test/25-mcp-write.test.ts test/38-desktop-main.test.ts test/66-control-seam.test.ts test/desktop-settings.test.ts test/desktop-settings-models.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts` | 180/180 通过，零跳过，约 104 秒 |
| `npm run check:static` | lint、根及全部 workspace/foundation 类型、笔记和文档门禁全部通过 |
| `npm run desktop:build` | Electron 构建通过；沿既有 ad-hoc 配置签名，未 notarize |
| `npm run desktop:mygo:build` | MyGo 构建及签名通过 |
| `codesign --verify --deep --strict 'dist/mac-arm64/Ruukoto.app'` | 通过 |
| `codesign --verify --deep --strict 'dist/mygo/darwin-arm64/Ruukoto MyGo.app'` | 通过 |
| `git diff --check` | 通过 |

新增 MCP 测试共 22 条，经过真实本机 Runtime、控制 socket、IPC 名单和隔离回环 MCP；覆盖两工作区与同工作区双原来源隔离、无会话默认与候选分页、CRUD/启停及版本冲突、凭据范围/主机/用途/头拒绝、取消与配置冲突后的秘密范围、引用清理、禁用发现零业务调用、脱敏、启停事件事务失败回滚、丢答不重发、原实例迟到结果淘汰、发现与刷新竞态、并发同名创建、服务身份回绕及删除后重复保存。共享穷尽 op 表与设置 SSR 预期随真实入口更新。

## 合成浏览器实测

Playwright CLI 的 Chromium 加载正式 App 与[合成 bridge](mcp.js)，入口为[页面夹具](mcp.html)。bridge 不访问真实服务，只保存合成元数据并记录操作名称，不记录秘密参数；这些结果不属于真实双外壳或 HTTPS MCP 验收。

- 通过页面完成匿名禁用草稿 → 发现两个工具 → 选择只读/副作用不明 → 保存 → 启用 → 停用 → 删除，之后确认无引用并清理凭据。
- 切来源遇到草稿时显示保存、放弃、继续编辑选择，放弃后切到另一来源；切回读取原来源。
- 合成已写入丢答时保存被禁用，读回前后 mcp_configure 次数均为 3，没有自动重发；随后放弃草稿显示读回的当前端点。
- 使用 Enter 打开认证选择、End 定位新 Bearer 项、Enter 选择；缺令牌提交时焦点准确落在 mcp-secret。保存后密码输入消失，页面文字与合成元数据均不含输入的模拟令牌。
- 480×850 下内容区域 clientWidth 与 scrollWidth 均为 318，无横向溢出；滚动到底部时范围文字仍在浮窗内。表单、页签、来源选择和确认窗保持键盘可达。
- 最终浏览器控制台 0 errors、0 warnings。首轮自动化未等待选择菜单聚焦，导致选择未变而保存按钮保持禁用；等待菜单可见并按真实键盘顺序重测后通过，不记首轮为产品缺陷。

已查看[深色总览](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmcp-dark.png)和[浅色窄窗编辑](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmcp-light-narrow.png)；截图不含真实凭据。

## 独立审查

独立上下文 `/root/mcp_state_review` 直接读取规格、实际源码、测试及文档，并执行最小验证。初轮发现刷新发现竞态、同名新增冲突缺比较、离线缺页内提示；后台复查发现 repoId 凭据约束和同名重建 ABA；末轮自查修正冲突后放弃草稿应恢复当前值。相关修复和回归均已汇总。

审查者首次亲跑两个 MCP 测试文件 20 条，19 通过、1 条暴露 repoId 漏校验；修复后失败条 1/1 通过。身份修复后亲跑旧版本冲突、同名显式选择、ABA 和删除后重复保存 4/4 通过；末轮放弃草稿回归 1/1 通过。最终独立结论无未解决工程阻断，git diff 检查通过；完整 180 条、静态与两壳构建由实施者执行并持有结果。

## 产品待验收与恢复条件

工单状态为 ready-for-human，工程验收通过。拥有者仍须在隔离档案使用真实 Electron 与 MyGo，完成配置 → 发现 → 允许 → 启用 → 停用 → 移除，并退出重开核实持久化、范围与体验；构建、签名和模拟浏览器不能替代该步骤。

真实 HTTPS MCP 尚未指定端点、凭据及允许验证范围，未联网验收、未执行业务工具。拥有者提供限定范围后，先确认隔离档案与凭据用途，再单独执行发现和授权范围内的验收。未运行全量 npm run check、真实模型或 Linux 全套验证；本单使用上表的相关最小检查集。

## 提交授权

2026-10-21，拥有者明确要求「提交」，据此提交当前分支，不推送。该指示不代表真实双外壳与 HTTPS MCP 产品验收已通过，工单保持 ready-for-human。
