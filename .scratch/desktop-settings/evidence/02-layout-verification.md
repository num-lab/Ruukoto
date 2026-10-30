# Code 模型页布局验收

日期：2026-10-21。本轮在 `c33314ee` 与既有未提交实现上重写模型设置布局；后台、TUI、配置来源读取及原生环境边界继续见[原实现证据](02-verification.md)。原有分级详情截图不代表当前界面。

## 现行交互

默认模型、Effort 与摘要模型在总览直接选择并自动保存；模型选择框 240px、Effort 80px，控制区右对齐。提供方新增／编辑均在同一完整弹窗内填写连接、存储 Key、模型能力与目录高级项，API 类型为选择框，未知但已有的协议值保留；内部提供方标识自动生成，模型 ID 由拥有者填写。提供方删除按钮在左下角并显示红色，保存按钮在右下角。叉号直接放弃草稿退出，不再弹草稿决策或显示草稿／保存中提示。

按拥有者逐项要求删掉自动保存说明、默认保存成功消息、普通凭据与高级字段解释、连接成功大提示及测试确认窗。点击测试直接执行，模型名旁黄、绿、红点分别代表未测、成功、失败；失败详情可用鼠标或键盘聚焦模型标题查看，测试按钮的鼠标／键盘提示保留联网与费用事实。配置变动后旧测试状态失效，不把旧成功用于新配置。

## 工程检查

| 检查 | 结果与范围 |
| --- | --- |
| `npx tsx --test test/desktop-settings-models.test.ts test/desktop-models-layout.test.ts` | 改版主流程及三色状态时 29/29 通过（真实本机控制面 23、布局 6）；末轮 Tooltip、读中测试淘汰与关闭清理由下列窄回归覆盖 |
| `npx tsx --test test/desktop-models-layout.test.ts` | 最终 7/7 通过；总览直接选择、完整提供方表单、OAuth 说明、索引字段错误、协议选择框、三色状态与迟到测试淘汰 |
| `npx tsx --test --test-name-pattern 'Desktop (设置保存|提供方)|连接测试迟到' test/desktop-settings-models.test.ts` | 8/8 通过；目录→读回→新修订 Key、Key-only 跳过目录、首步未知不提交 Key、次步未知部分成功、提交中退出不继续及测试状态失效 |
| `npm run check:static` | 最终 lint、全 workspace 类型、笔记与文档门禁通过 |
| `npm run desktop:build`、`npm run desktop:mygo:build` | 最终两壳构建成功；现有 chunk／构建配置提示不阻断，Electron 沿原配置未 notarize |
| `codesign --verify --deep --strict` | 最终 Electron 与 MyGo 应用签名检查通过 |
| `git diff --check` | 通过 |

提供方与存储 Key 使用两个既有修订操作。目录有变化时成功保存并读回后才提交 Key；目录失败或未知立即停止，后一步失败保留目录已保存的事实，不伪称整体回滚，也不重发。提交中叉号退出保留原 pending，已受理目录仍会落盘，但不继续后续 Key 操作。未知结果关闭弹窗后仍在总览核实；只读核实不重发。秘密输入提交后清空，pending 不保存正文。

## 合成浏览器实测

Playwright CLI 的 Chromium 加载正式 App／renderer 与[合成 bridge](models.js)，不访问真实模型或日常配置。浏览器桥只记录操作名，不记录秘密参数。

- 默认／Effort／摘要实测宽度为 240／80／240，Effort 与摘要右边缘差 0；480×850 下控制区适应内容宽度，无横向溢出。
- 改 API 类型和名称后点叉号，再打开读到原值；新增提供方在同一弹窗填写连接、存储 Key 与模型，一次保存依次发送目录和 Key，重开保留模型 ID 与凭据元数据。
- 模型 2 留空 ID 时只有 1 个输入标错，焦点为 `catalog-model-1-id`；收起时错误会展开正确模型。退出后不遗留旧字段提示。
- 默认／摘要直接保存仍留总览；合成已写入丢答后禁用继续编辑，核实请求前后写入次数相等。
- 未测试为黄，直接测试成功为绿、合成 `ok: false` 为红；无额外测试确认对话框和大结果提示。成功绿为 `rgb(84, 184, 120)`、失败红为 `rgb(227, 103, 103)`。
- 键盘聚焦模型标题能看到失败详情，聚焦测试按钮能看到联网／费用提示；两者的 `aria-describedby` 均关联实际 tooltip ID。修正缺失 Provider 后，最终重载至完整操作期间 page errors 为 0。
- 删除按钮位于保存按钮左侧、同一行并使用 destructive 红色；窄窗 footer 保持可用，弹窗体内滚动。

已查看最终[深色总览](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-overview-dark.png)、[深色提供方](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-provider-dark.png)、[浅色总览](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-overview-light.png)、[浅色提供方](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-provider-light.png)、[窄窗总览](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-overview-narrow-light.png)、[窄窗提供方](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-provider-narrow-light.png)、[窄窗模型字段](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-provider-narrow-fields-light.png)与[键盘失败详情](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-layout-final-keyboard-error-dark.png)。截图等待弹窗过渡完成；此前迭代图只作临时资料，不作为最终验收。

## 独立复核与交接

独立上下文 `/root/desktop_test_audit` 审查同窗方案与最终实现，直接读取代码、要求、文档及截图，亲跑布局 7/7、真实保存与迟到测试 2/2、关闭／pending 2/2；独立断言另验 Key 明确拒绝时保留目录成功、秘密清空、无新输入不重发。审查指出的多模型字段定位、失败详情可访问性、费用提示及缺失 TooltipProvider 均已修复和复核，无剩余阻断。最终快照：state `aabf031ef67a`、UI `6a93a3dfa93b`、CSS `4d2adfb56dc4`。

工程验收通过，拥有者在最终排版交付后明确要求结单并提交，工单为 `resolved`。未运行付费真实模型，未执行真实 Electron／MyGo 配置后退出重开；模拟 bridge、真实本机 IPC 测试、构建与签名不能替代这些验证。按拥有者授权提交当前分支，未推送，不修改日常真实档案。

## 字号与间距微调

拥有者追加要求仅涉及总览排版，按轻量路径处理：两个分组标题为 15px／700，默认与摘要标签为 14px／400 常规正体，分组间距从 24px 增为 36px；「添加提供方」为 13px。规则只作用于总览，提供方弹窗与选择框尺寸沿用原值。布局用例 7/7、静态检查通过，Chromium 实测字号／字重／间距均匹配，480px 窄窗无横向溢出；[桌面截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-typography-dark.png)与[窄窗截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-settings%2Fevidence%2Fmodels-typography-narrow-dark.png)覆盖此次排版。上述两壳构建与签名仍对应前一版，本次纯样式微调未重新打包。

## 拥有者结单

2026-10-21，拥有者在最终布局和字号调整交付后明确要求「转 resolved 并提交」，据此关闭工单并提交当前分支。此指示作为结单依据，不新增或改写真实环境证据：真实模型与原生应用配置后退出重开仍未由 agent 执行，本次最后字号微调未重新打包；未推送远端。
