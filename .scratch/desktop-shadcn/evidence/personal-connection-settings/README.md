# PA 远程连接设置验收

日期：2026-10-17；范围：可变 demo 工单13，叠加主会话工单12的未提交改动。环境：macOS、Node 24.15、IAB 的 http://127.0.0.1:5173/，视口 949 × 827。测试主机 pa-server 与目录 /srv/ruukoto/control 仅为浏览器输入，不是 fixture 或真实连接。

## 工程检查

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过：类型、渲染／提交自检、原稿来源核对与 Vite 生产构建。新增自检核对默认空主机与默认目录、必填、标签／帮助文本／保存按钮，以及以浏览器 v 标志编译后的两字段字符范围。保存反馈补入面板内部 role=status 后重新执行，全部通过。构建仍有原有单 chunk 大于 500 kB 的提示，无 npm 依赖变更。

`npm run check:static` 通过。末次实现改动仅为 demo 内保存反馈与 README 文字；其后 demo check 和 diff 检查通过，正式应用及后台未改。Field／Label 为官方 radix-rhea registry 的实际使用部分，CLI view 获取后核对并调整导入。

## 浏览器检查

| 操作 | 观察结果 |
| --- | --- |
| 从 Code 打开设置 | 新增 PA 远程连接类别，保留外观／演示状态，无运行目标 |
| 首次打开表单 | 主机为空，目录为 /var/lib/ruukoto/control；只有两个字段与保存按钮 |
| 空主机、user@host、pa server、-pa、pa:22 点击保存 | 原生 valueMissing 或 patternMismatch 为真，不应用配置 |
| 空目录、relative/control、/pa:bad、/pa server 点击保存 | 原生校验阻止保存；[九个输入的实际结果](validation.json) |
| 以上无效编辑切换类别再回来 | 仍为空主机与默认目录，证明未保存非法值 |
| 填写 pa-server 与 /srv/ruukoto/control 后保存 | 面板内显示配置已保存，并明确没有建立真实 SSH；[保存快照](saved-state.txt) |
| 改成未保存值，再切换外观并返回 | 丢弃编辑，恢复合法的已保存值 |
| 改成 closing-draft 后关闭，从 PA 再打开 | 恢复 pa-server，目录仍为已保存值；[重开快照](reopened-state.txt) |
| PA 中保留输入草稿、打开设置并用 Enter 保存 | 不切换主会话，不清空草稿，右栏仍只有浏览器／SubAgent；[保存后的 PA](pa-after-settings.txt) |
| 明暗切换 | 字段、按钮、提示均可读；见[暗色](dark.png)和[浅色](light.png)截图 |

表单合法保存、重开值、类别切换丢弃草稿、PA 输入与右栏隔离均执行了断言。关闭的即时 AX 曾仍暴露退出动画中的模态窗口，等窗口退出后完整快照确认 PA 草稿与右栏不变；未把该中间状态记作界面失败。当前 949px 视口中设置宽720px，clientWidth与scrollWidth均718px，无横向溢出。

## 未验证

未连接 SSH、读取本机 SSH 配置或真实 PA，不执行正式后台的路径规范化、socket 长度与权限校验。刷新会重置内存配置。小于540px的设置窄布局尚未实际验收，当前IAB未提供调整视口能力；保留人工观感与更窄窗口验收。未运行全量应用测试、生产 Desktop 构建或系统文件选择器。
