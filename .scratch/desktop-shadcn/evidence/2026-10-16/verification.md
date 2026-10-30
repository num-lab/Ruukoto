# 浏览器批注版验收

日期：2026-10-16。对象为拥有者提交的 11 项浏览器批注，当前源码哈希见[source-hashes.json](source-hashes.json)。上一轮的审批展开门槛、顶部布局及附件范围结论失效，其余历史证据保留。产品验收待拥有者继续审阅。

## 工程验收

`npm --prefix .scratch/desktop-shadcn/demo run check` 通过：类型、首屏渲染、原稿基础样式一致性及生产构建。新增断言覆盖 Edit／Edited 去重与 Write 计数、无编辑时不回退文件名、直接审批、附件入口、移除顶栏新建及标签区独立。`npm run check:static` 和 `git diff --check` 通过。独立审查者 desktop_audit 亲读源码、亲自 check，并用独立 SSR 样例检查 Agent-only、附件草稿和按钮类型，无未解决阻断。

## 浏览器亲验

在独立 QA 标签测试，保留用户预览；检查 1003×827 与 760×500，分别保存[深色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fpreview-dark.jpg)及[浅色](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fpreview-light.jpg)截图。控制台最终无 error。

| 批注 | 实际结果 |
| --- | --- |
| 1：diff 紧跟文件名 | 默认 Edit 详情中增删统计左端与文件名右端相距 10px |
| 2：子 Agent 不进分组 | Schema Auditor 独立可点，其祖先不含 activity-group；点击打开正确子会话 |
| 3：摘要只显示 edit/write 数量 | 默认摘要为「Edit 2 个文件」，不含文件名或子 Agent；独立断言覆盖重复编辑和 Write |
| 4：模型在发送左侧 | 1003px 下模型右端与发送左端相距 6px；760px 展开右栏时仍在发送左侧 |
| 5：模式左侧附件加号 | 通过真实文件选择器选取本目录 attachment-demo.txt；显示模拟附件芯片、启用文件单独发送；切到 MCP 不带入附件，切回恢复，移除成功 |
| 6：去掉展开门槛 | 首屏批准／拒绝可用，命令、工作区与用途常驻；直接批准后显示「已模拟批准 · 未执行」 |
| 7：内联代码高度降低 | 上下 padding 从 3px 降至 1px，浏览器计算值均为 1px |
| 8：去掉顶栏新建 | 顶栏无「新建会话」按钮，工作区行的创建入口仍保留 |
| 9：长工作区名截断 | macos-menubar-kit 为 nowrap + ellipsis，不换行 |
| 10：工作区组间距减小 | margin-bottom 从 8px 降至 4px，浏览器计算值为 4px |
| 11：顶部区域独立并高于右栏 | header 不在 main 内；1003px 下 header 高 48px、底部与右栏顶部均为 68px；右栏展开后输入与审批仍可见 |

760×500 展开右栏时 main 宽 226px，输入工具栏按容器宽度分两行；模型和发送均在 main 内，发送仍在窗口内。测试后清除浏览器尺寸覆盖并关闭 QA 标签。

## 范围与限制

本轮只修改 demo 和相关记录，没有迁移正式 desktop。附件只在内存保存名称与大小，未读取或上传内容；所有审批与回复均为模拟。正式附件输入、模型接收与真实 Electron 仍需后续迁移时实现和验收。
