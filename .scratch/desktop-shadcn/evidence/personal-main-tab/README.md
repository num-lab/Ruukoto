# Ruukoto 主会话验收

日期：2026-10-17；范围：可变 demo，基点 53fad80 加本轮未提交改动；环境：macOS、Node 24.15、IAB 中 http://127.0.0.1:5173/，截图视口为 839 × 827。全部对话与提交均为前端模拟，测试没有连接真实 Personal 后台。

## 工程检查

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过：TypeScript、渲染／提交自检、原稿来源核对及 Vite 生产构建。新增断言覆盖入口顺序、PA 固定身份、空初始历史、不混入工作区、执行预览不注入 Code 调用、发送保留固定标题及通用模拟回复。构建保留已有的单 chunk 超过 500 kB 提示；本轮无依赖变更。

`npm run check:static` 通过：全仓 lint、类型、笔记与文档检查。`git diff --check` 通过。未执行全量应用测试和正式 Desktop 构建，本轮没有修改其实现。

## 浏览器检查

| 操作 | 观察结果 |
| --- | --- |
| 连续点击 Ruukoto | 只出现一个 personal:main 标签，工作区列表常驻；窄栏自动显露当前标签 |
| 输入 PA 草稿，关闭标签再从入口打开 | 同一主会话恢复草稿 |
| 按 Enter 发送 PA 草稿，立即切回 Code | 延迟核实后用户输入与模拟回复仅出现在 PA；Code 保持原对话和空草稿 |
| PA 选择 o3-mini，输入第二份草稿，关闭重开 | 历史、第二份草稿与模型保留；Code 模型仍为 Claude 3.7 Sonnet |
| 打开设置 | 只有外观与演示状态类别，无运行目标；见 [设置快照](settings-state.txt) |
| PA 打开演示状态菜单，选择 Working | 菜单无工具详情／差异场景；消息流只追加 Working，不出现 Code 文件和命令 |
| PA 使用右栏按钮与 ⌘J | 正常开合；新标签页只有浏览器和 SubAgent，无文件树、工具差异或文件预览 |
| PA 打开、关闭浏览器 | 能打开本地预览地址，关闭后返回受限新标签页 |
| Code 打开正文差异、文件树、indexeddb.ts 预览，再切回 PA | Code 差异／文件树／高亮预览正常，PA 不带入 Code 右栏；见 [Code 快照](code-after-pa.txt) 与 [PA 快照](personal-state.txt) |
| 键盘 Enter 激活 Ruukoto、方向键调整右栏、⌘J、⌘ShiftL | 保持唯一标签，开合、调宽和主题切换可用 |
| 明暗与窄栏布局 | 消息流与输入区复用现有样式，按钮不换行；见截图 |

浏览器末尾对唯一 Ruukoto 标签、PA 草稿／历史保留、PA 右栏不含文件树／差异、Code 不含 PA 输入及设置不含运行目标做了断言，均通过。截图中的验收文本只是本次浏览器操作输入，未写入 fixture。

- [暗色，PA 与右栏](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fpersonal-main-tab%2Fdark.png)
- [浅色，PA 与右栏](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fpersonal-main-tab%2Flight.png)
- [暗色，右栏收起](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2Fpersonal-main-tab%2Fdark-collapsed.png)

## 验收边界

工程与可观察交互已验证，布局主观体验留给拥有者审阅。真实 Personal 连接、持久化、生产 Desktop 同步均不在本轮范围；刷新会清空 demo 内存状态。附件元数据沿用已有提交用例，未重做系统文件选择器验收。
