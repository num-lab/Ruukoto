# 设置容器验收记录

日期：2026-10-21。起始检出 `271f83c71139df91129eee28a9364ec8f90ecc00`，工作区干净；相对规格基点 `614d97cecb693f934b80486d20723fcda533a993` 的已提交差异为设置规划与批准记录。本次只修改设置容器、现有 PA 连接表单、对应测试与文档，没有操作真实配置；本地提交按拥有者随后明确授权执行，未推送。

## 工程证据

| 检查 | 结果与范围 |
| --- | --- |
| `npm run setup` | 依赖与钩子初始化通过；没有修改依赖清单或锁文件 |
| `npx tsx --test test/43-desktop-demo.test.ts test/desktop-settings.test.ts test/desktop-session-settings.test.ts` | 44/44 通过；包括原有会话设置与新会话来源回归 |
| 最终修复后 `npx tsx --test test/43-desktop-demo.test.ts test/desktop-settings.test.ts` | 14/14 通过；覆盖保存或核实完成后旧提示消失 |
| `npm run check:static` | lint、全 workspace 类型、notes、docs 检查通过；最终状态见工单 |
| `git diff --check` | 通过；另核对新增文本单个末尾换行 |

新窄测包括无会话、三类独立目标、工作区/原来源、来源候选归属及名称、未保存导航三选、保存中/待核实锁定、断线后同实例重连与换实例旧票据淘汰、非管理页期间换实例、页面身份保留、PA 的 not_sent/rejected/unknown/disconnected、核实再失败、冲突草稿、字段错误和 SSR 内容插槽。读取修订由具体管理页持有；本机旧 PA 连接 API 没有修订字段，容器不制造虚假版本保护。

基点的 `style.css` 已在定稿内容间加入终端样式，加载样式后也有终端覆盖，原 43 的完整前缀/固定后缀断言已不成立。本次保留逐行定稿原文及顺序验证、加载块原文与官方组件逐字验证，允许正式功能插入/追加样式；没有修改冻结 demo 或组件。

## 浏览器合成验收

使用 playwright CLI 和 Chromium，在 Vite 中加载正式 App 与[合成 bridge](settings.js)，没有真实后台、SSH、模型或 MCP。用于重放的[页面](settings.html)位于仓库根 Vite server 的 `/.scratch/desktop-settings/evidence/settings.html`；需启用现有 React 与 Tailwind Vite 插件。

- 无会话打开六分类；PA 在 Personal closed 时仍可读取和编辑宿主连接配置。
- 编辑 host 后切模型页会出现保护提示；继续编辑保留原文。Escape 同样触发保护；保存并继续后恰有一次合成保存，关闭后焦点回到「设置」。
- 纵向方向键可从外观切到模型，Tab 可进入面板；明暗选择实际修改根主题。
- 430×420 视口的浮窗为 x=16、y=24、398×372；面板 clientHeight=370、scrollHeight=601、clientWidth=scrollWidth=268，可滚至保存按钮且没有横向溢出。
- 减少动态效果下，编辑 PA 后 ⌘B 仍先确认，放弃后收起侧栏，动画/自动归焦完成后焦点回到「展开侧栏」。
- 已查看[深色宽窗](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fsettings-dark.png)及[浅色窄窗底部](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fsettings-light-narrow.png)。首次临时页面仅有缺 favicon 的 404；保存的重放页已使用空 data favicon，没有 renderer 异常。

浏览器检查中的第一次方向键断言和侧栏焦点断言在 React/自动归焦提交前读取，等待实际状态完成后均通过；没有据此修改产品交互，也不以这些即时读数声称失败。截图由合成配置生成，无秘密。

## 独立实现审查

独立上下文 `/root/implementation_review` 直接读取规格、规则、实际改动、测试与文档，亲跑 14/14 窄测；发现阻止导航的保存/待核实提示在完成后残留。实施者改为按当前阶段派生提示，并加入回归断言；审查者复核最终修复、再次亲跑 14/14，结论通过，无未解决阻断。前置只读上下文 `/root/scope_audit` 核实授权与范围，并指出换实例、来源候选名称和持有原操作的组件生命周期问题，均已处理。

审查者未代替作者执行静态检查或外部验收。工程通过仅针对本单的 renderer 与共享交互，不证明后三类管理 API、新 Personal 或两壳服务链路。

## 产品验收与交接

拥有者在目标页签调整完成后明确要求「转resolved并提交」，本单按拥有者产品接受关闭为 resolved。代理仍未执行真实 Electron/MyGo 两壳、SSH/新 Personal、模型或 MCP 验收，不将合成 bridge 或 SSR 计为这些环境通过，也不推断拥有者具体检查了哪些步骤；模型、Skills、MCP 仍显示未接入且只读，后续能力按其余工单实施。

后续页面使用 `SettingsDialog.pages`，组件获得 category/scope/settings/code/personal；03 将实例/工作区归属明确的来源候选接到 `mcpSources`，未验证来源时 scope.sourceId 为 null。页面自己持有读取修订、草稿、当前值和原提交，注册 SettingsForm 并实现 invalidate；只有明确导航改 pageKey，快照和实例变化保留原页面。细节与理由见[决策记录](../../../.agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md)。

## 配置目标页签调整

2026-10-21，依据拥有者截图反馈，将目标下拉框替换为现有 shadcn/ui Tabs，仅显示 Code、PA，删除标题、说明与重复范围提示，MCP 工作区/来源字段继续按目标呈现。目标面板由 TabsContent 关联；两个按钮沿用保存中/待核实禁用和原 chooseTarget 保护。嵌套纵向分类时，局部样式保持目标页签横向排列和居中。

作者重跑 14/14 定向测试、check:static 与 git diff --check，通过。独立上下文 `/root/target_tabs_check` 复核结构与交互保护，亲跑 SSR 窄测 1 项通过，无阻断。Chromium 合成 renderer 核实目标区域文本恰为 Code/PA、两个页签位于同一行、aria-controls 指向实际面板、方向右键选中 PA；已查看[当前页签截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fsettings-target-tabs.png)。这次仅复测局部 renderer，没有新增真实 Electron/MyGo 或远程服务证据。
