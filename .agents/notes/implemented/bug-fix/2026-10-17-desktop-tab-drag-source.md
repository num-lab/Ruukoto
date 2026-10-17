# Agent Note: 拖动源标签的显示周期

Status: implemented

## 问题

Tab 拖出列表后清空目标槽位，源标签提前可见；其回程与相邻项的避让动画交叉，出现重叠。

## 决定

源标签首次进入拖放预览后保持隐藏，直到 drop／dragend 或所属组重置；离开列表只撤回目标避让。Demo 与 Desktop 使用相同语义，仍由原生拖放持有拖影。 需求与验证入口见[工单20](../../../../.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md)。

## 既有决定

检索 Desktop、Tab、消息渲染、文件预览、产物、会话默认设置的 implemented／proposed／rejected；与[既有迁移](../architecture/2026-10-17-desktop-demo-v4.md)部分重叠，本篇补充对应生命周期与读取／创建语义，其余迁移约定继续适用。其他命中无关。

## 备选方案

离开列表立即显示源项最直接，但回程会穿过相邻项；重写指针拖放可完全控制拖影，但已有生命周期修正足以消除已复现重叠，不扩大实现。

## 后果

真实 hook 事件重放覆盖离开、重进、取消、drop 和组重置；该用例证明 DOM 源项生命周期，不替代原生拖影截图。

拖动结束后原位置的hover残留另由[hover资格](2026-10-17-desktop-tab-hover.md)处理；本篇的源显示周期继续适用。
