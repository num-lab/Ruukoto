# Agent Note: 拖动后撤销旧位置的 hover

Status: implemented

## 问题

原生拖放结束后，浏览器仍让原位置的Tab匹配:hover；拖动状态已清空，背景、关闭图标与文字渐隐却残留。[拖动源显示周期](2026-10-17-desktop-tab-drag-source.md)只处理回程重叠，不能解决这个状态。

## 决定

两组标签分别管理hover资格：拖动开始、drop、dragend、键盘排序和所属组／成员变化均暂停；只由本组拖动结束后的指针移动恢复。暂停时忽略旧位置hover背景，隐藏关闭图标并停止其鼠标命中，撤掉文字mask；focus-visible保留关闭键显示、命中与文字避让。选中项仍显示选中背景。Demo和Desktop沿用原生拖影、等宽避让及稳定对象身份，不改共享Tab原语。

## 既有决定

检索Tab拖动、排序、hover、毛玻璃及动态宽度。与前述源显示周期和[迁移](../architecture/2026-10-17-desktop-demo-v4.md)部分重叠，原有拖动源、宽度、组身份和键盘语义继续适用；本篇补充指针样式资格，不取代源隐藏修复。其余命中无关。

## 备选方案

仅清拖动标记最短，但实际DOM中标记已清、:hover仍为true；blur会移走键盘焦点且不处理hover缓存。重写pointer拖放能完全持有命中状态，但没有必要替换已有原生拖放，只隔离不可信的结束后hover。

## 后果

实际Demo红绿记录覆盖旧位置背景、关闭键命中和文字渐隐，键盘Tab仍可显示关闭键；hook回归覆盖取消、组变化及恢复，独立于源隐藏用例。原生MyGo的拖影与hover仍需在其鼠标环境复验，证据归[工单21](../../../../.scratch/desktop-shadcn/issues/21-polish-history.md)。
