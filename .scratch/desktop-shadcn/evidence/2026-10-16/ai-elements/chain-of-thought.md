# 思考摘要与内联代码字号验收

范围：仅独立 demo；按最新批注加入思考显示，正文内联 code 由 14px 调为 13px。正式 GUI、后台、冻结稿、原始 reference-data.json、官方原语及本轮前的 CSS 保持原样。

实现采用 [shadcn/ui Chain of Thought 的 Radix 模式](https://ui.shadcn.com/docs/ai-elements/radix/chain-of-thought)，直接使用现有 Trace、TraceCollapsible 与内层 TraceLine，无新依赖。离线同步样例在用户输入后装配三条高层模拟摘要；其他会话没有该数据，不追加显示。默认收起；不表示恢复了真实模型思考。

工程检查：`npm --prefix .scratch/desktop-shadcn/demo run check` 与 `npm run check:static` 通过。新增断言覆盖样例位置、默认收起、三条内容、仅目标会话，以及 SSR 收起／展开；原审批消失、提交核实、工具摘要与来源检查继续通过。独立方案与实现审查均无阻断，审查者亲跑 demo check 并核对 13px 构建样式。

浏览器：837×827；鼠标、Enter、Space 均能切换思考区域。A→B→A 会话切换后，B 没有思考入口，A 保留展开，工具组仍收起。主／子消息 code 实测为 13px、400；命令仍为 14px、44px 高且无滚动条。文件路径按 Enter 仍打开对应差异。右栏展开后消息内容宽 239px，三条摘要自然换行且无横向溢出；深色和浅色均核对。其他六区的尺寸与背景在改动前后逐项一致，原 80 文件哈希保护和本轮 CSS 字节核对通过。

效果见[深色主视图](chain-of-thought-dark.png)、[浅色窄栏](chain-of-thought-light-narrow.png)，计算样式与尺寸见[测量数据](chain-of-thought.json)。仅模拟展示；未接真实模型思考、后台或正式桌面，外观交拥有者审阅。
