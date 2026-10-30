# 分类设置窗口验收

日期：2026-10-16。对象为拥有者「点击后打开设置悬浮窗口：左侧为设置类别，右侧为具体设置项」批注。[源码记录](settings-source-hashes.json)覆盖 App、样式和渲染断言。旧演示下拉菜单及其验收保留为历史。

## 工程验收

`npm --prefix .scratch/desktop-shadcn/demo run check`、根 `npm run check:static` 与 `git diff --check` 均通过。

复用 shadcn Dialog、纵向 Tabs 与 Select，只重排已有主题、Code／Personal、预览场景；没有新增真实配置或依赖。SSR 新增入口 aria-haspopup 为 dialog、旧菜单入口移除的断言。独立方案和实现复核发现 Select Portal 内关闭侧栏的焦点遗漏，已在 Dialog 实际关闭边界补归还动作，最终复核通过；审查者亲自执行窄 SSR 检查通过。

## 浏览器亲验

使用独立后台 QA 标签，保留拥有者预览。955×827 下窗口为 720×480，左侧类别、右侧具体设置项，见[深色窗口](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fsettings-dark.jpg)。左侧方向键切换至运行目标，非活动内容隐藏；切浅色即时移除根 dark，Personal 切换后显示个人 Agent 占位，切回 Code 正常；选写入空文件仍调用原处理，打开 empty.ts 且差异零行。

首次 Esc 关闭 Select 后窗口仍在且焦点为主题；第二次 Esc 关闭设置后焦点为设置入口。连续六次 Tab 均在模态内。设置内 Select 展开时按 Meta+B，窗口与菜单均关闭、侧栏 inert、焦点为展开侧栏；遮罩点击也能正常关闭并归还入口。

480×500 下窗口为 448×452，位于 x16、y24，左侧类别宽 128px、右侧 318px，选择框处于右侧范围内，无类别横向溢出，见[窄窗口](../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fsettings-narrow.jpg)。关闭 Dialog 的尺寸补间后，缩放时不会因旧宽度短暂越出视口；原打开／关闭动画保留。扩大回 955×827 后恢复 720×480，完整处于视口内。控制台无 error 或 warn；结束后关闭 QA 标签并清除尺寸覆盖，保留拥有者原有预览。

## 范围

仍为内存演示，设置项刷新后重置。设置窗口版式纳入后续定稿迁移；演示场景与模拟目标不作为正式配置能力，没有修改或验收真实 Electron。
