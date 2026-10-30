# 顶部标签与模型菜单验收

本轮仅修改独立 demo，覆盖拥有者的四条浏览器批注；正式 Desktop、后台、冻结稿、原始 fixtures 和官方源码原语保持原版本。独立方案与实现审查均无阻断。

## 结果

- 右侧 tab、关闭与加号移到窗口顶部；原内容区不再占用第二排 header。1093×827 下顶部右区与检查器均为 left=698、right=1073、width=375。键盘调宽至 391px、拖动至 415px 后，左右边界及宽度仍相同，调宽期间两处均无过渡延迟。
- Thought→子 Agent 为 16px，activity 内子 Agent→工具摘要为 16px，activity→正文仍为 24px。其他正文、审批与内联 code 不变。
- 模型菜单包含模型和 Effort 两个命名 radio group，保留认证不可用模型禁选。实测选择 High 后模型不变，改成 o3-mini 后 High 保留；切换其他会话为 Claude／Medium，切回后恢复，新建继承 o3-mini／High。核实期间入口禁用、草稿只读，完成后恢复。
- 模型入口在 321px composer 内容区显示名称，319px 时变为 27px Brain 按钮，当前模型和 Effort 的可访问描述不变。760×827 双侧栏开启时内容区为 144px，Context、Brain 和发送同排且无页面横向溢出。
- 顶部文件／Agent tab 可切换、关闭，单个 tab 不显示分隔线；关闭最后 tab 得到新标签，加号新增标签，文件及 Agent 可重新打开。tab 内 Ctrl+J 收起后，焦点归「展开右栏」，隐藏 tab 为 aria-hidden／inert。
- 菜单向上弹出，enter 位移为 0、scale 为 1；方向键跳过禁用模型，Enter 可选择 Effort，Escape 返回模型入口。全局 SVG 尺寸只在新模型菜单内让位给官方类，两个 radio 选中圆点均为 8px。
- 明暗均核对顶部布局；Context 的键盘聚焦详情仍显示 Progress=16。临时视口已 reset，验收新会话与选择已通过刷新清除，最终页面恢复默认样例和深色。

## 工程与范围

`npm --prefix .scratch/desktop-shadcn/demo run check`（类型、SSR 与原稿来源、生产构建）通过，`npm run check:static` 通过；最后局部 SVG 样式修正后再次通过 demo check。SSR 新增顶部 tab 位置、隐藏 tab 不可聚焦、合并菜单入口语义与核实时禁用检查，原审批、思考、滚动结构及 Context 检查保留。独立审查亲跑 demo check，通过；80 个正式文件／冻结稿／来源哈希保护核对通过。

未验证真实 Electron、后台、真实模型或真实用量，本轮使用内存样例，未提交或迁移正式 GUI。外观由拥有者审阅。

## 证据

[深色整体](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fheader-model-dark.png)、[合并菜单](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fheader-model-menu.png)、[浅色](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fheader-model-light.png)、[144px 窄栏](../../../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fheader-model-narrow.png)；完整 DOM 测量和交互记录见[JSON](header-model.json)。
