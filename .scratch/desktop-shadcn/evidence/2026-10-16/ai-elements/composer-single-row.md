# 输入框底部功能键同排

本轮只修正 demo 的响应式 CSS，不修改 React、组件原语、数据、正式 Desktop 或后台。旧 480px 规则主动设置 wrap 和左右组 width:100%，导致两排；现已删除，功能键始终同排。模型紧凑断点前移到 480px，220px 以下收紧内外 gap 并以保留辅助技术文本的方式隐藏模式选项文字。

当前 1093×827、右栏 396px、composer 内容 349px 时，五控件顶边相差不超过 1px，操作行高 34px、输入框高 104px，无横向溢出。760×827 双侧栏开启的 144px 内容区，五控件宽度为 26／27／27／27／28px，仍为同一排，控件边界位于容器内。622px 宽内容区仍显示模型名并同排。

最窄布局实测模式菜单选择 Ask for approval，关闭后 AX 仍显示当前值；恢复 Auto review 后，模型／Effort 菜单可打开，Context 键盘详情为 Progress=16，填写草稿后发送按钮启用，随后清空。明暗均核对 349px 布局；临时视口已 reset，默认模式、空草稿与深色已恢复。

`npm --prefix .scratch/desktop-shadcn/demo run check` 与 `npm run check:static` 通过；只读独立复核无阻断，审查者亲跑 demo check 通过。80 个正式文件／冻结稿／来源保护核对通过；未做真实 Electron 或后台验收。本轮不新增逻辑测试，用真实浏览器几何和操作记录验证样式回归。

效果见[深色](composer-single-row-dark.png)、[浅色](composer-single-row-light.png)、[最窄布局](composer-single-row-narrow.png)，测量见[JSON](composer-single-row.json)。
