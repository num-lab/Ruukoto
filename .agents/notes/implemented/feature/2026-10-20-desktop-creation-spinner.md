# Agent Note: 新建会话在途显示加载图标

Status: implemented

## 问题

新建会话点击后，左栏每一行的加号都只是被禁用，直到后台返回才打开会话。请求在途期间没有任何进行中的反馈，按钮被禁用反而更像界面卡住；多个工作区的行同时变灰，也看不出是哪一个请求在跑。`CodeState.create` 已经把在途操作保存在 `pendingCreation` 里，但 `busy` 字段只在内部用于阻止重发，发起请求时没有触发重绘，界面拿不到「正在发」这一刻。

## 决定

- `sendCreation` 在把 `pending.busy` 置真后调用 `mark()`，让渲染进程立即重绘；`busy` 由此成为界面上「请求在途」的可用信号，重发与核实仍按原逻辑。
- 工作区行渲染时比较 `models.code.pendingCreation`：仅当 `op === "create_session"` 且 `params.project_id === project.id` 时，该行把 `Plus` 换成 `Loader2.animate-spin`，`aria-label` 改为「正在新建会话」。
- 其余新建入口（添加工作区、其他工作区行、添加工作区后的再次创建）继续由既有的 `!!models.code.pendingCreation` 禁用，不退化为多个加载图标。
- 正式追加段补 `.workspace-row .workspace-add:has(.animate-spin) { opacity: 1; }`：基础规则让悬停显露的添加键默认透明，禁用态又叠了 50% 透明度，不覆盖的话加载图标会看不见。旋转沿用 Tailwind 的 `animate-spin`，减少动态效果时由全局规则关闭动画。

## 备选方案

- **所有新建入口都换加载图标**：多个入口同时转圈会暗示多个请求在跑，而 `create` 只允许一个在途请求；只标发起行能准确表达「哪一个在工作」。
- **给 `PendingCreation` 增加界面专用字段**：`busy` 已经准确表达「请求已发出、等待应答」，新增字段只是同义重复，还要在 `complete`／失败分支同步维护。
- **用 toast 或顶部进度条**：位置离操作点远，且现有的 `pendingCreation` 禁用态已经说明「暂时不能再点」，局部图标更直接。
- **改冻结前缀里的 `.workspace-add` 规则**：`test/43-desktop-demo.test.ts` 要求正式样式以冻结 demo 原文开头，只能在追加段覆盖。

## 后果

点击新建后，发起行的加号在原位变成旋转图标，直到会话创建成功（打开新会话）或失败（恢复加号并提示）。`test/40-desktop-creation.test.ts` 增加断言：在途记录 `busy` 为真且已触发重绘，覆盖「加载图标不等到应答才出现」的回归。代价是界面现在依赖 `busy` 的时序：若以后有人在 `sendCreation` 之外复用 `pendingCreation` 而不置 `busy`，加载图标不会出现；该字段仍只在 `sendCreation` 内写入。`docs/modules/desktop.md` 同步说明仅发起行显示加载图标。
