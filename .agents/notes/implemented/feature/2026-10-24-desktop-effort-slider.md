# Agent Note: Effort 档位改为分段粗滑杆

Status: implemented

## 问题

Effort 在模型菜单内是一个 `DropdownMenuLabel` 加一列 radio 项，一档一行，占纵向空间多，且与「档位是连续强度的一条刻度」的心智不符。拥有者要求改成一条粗 slider。

## 决定

`composer.tsx` 新增 `EffortSlider`：档位渲染为一条圆角粗轨道上的等宽分段，选中档及其左侧填充（`--bg-surface-hover`）表示滑块位置，选中档以选中色（`--selection-surface`）与加重字重作滑块；替代原 label 之下的 radio 组，`DropdownMenuLabel` 标题保留。模型不可用时整体禁选；模型不在目录（`thinkingLevels` 未知）时退化为单个只读档位展示当前值；未选择模型时不渲染。

档位仍是 `DropdownMenuItem`（`role="menuitemradio"` 覆盖默认 role），因此保留菜单的键盘导航、Enter 选中与选中后收起，不引入新原语或依赖；视觉样式在 style.css 追加区的 `.effort-*` 类，菜单项默认样式由该作用域覆盖。继承链不变：显式选择的档位随会话保存，切换模型沿用 `selectionForModel` 的保留/回落规则。

本篇部分取代[模型菜单](2026-10-16-demo-header-model-menu.md)中「两个命名 radio group」的 Effort 部分；Effort 收进模型菜单、按会话保存与禁用规则继续适用。

## 备选方案

- **原生 `role="slider"` 拖拽控件**：语义最贴近滑杆，但 Radix 菜单的键盘导航只覆盖菜单项，slider 需要自管焦点与方向键，且拖拽需要指针精确落在轨道上；分段的菜单项档位免费获得这些行为。
- **保留 radio 列表仅加粗行高**：改动最小，但仍是逐档一行，没有滑杆的位置感。
- **滑杆移出菜单、放在输入区功能键上**：窄栏已按宽度收紧功能键，再放一条滑杆会挤压模式与模型入口；维持本篇的菜单内位置。

## 后果

一屏内可见全部档位与当前位置，纵向更紧凑；代价是档位文字变 12px 且长档位名（如 Minimal）在窄菜单下由等宽分段均分，极端档位数（>5）会显挤，当前目录档位数远小于此。键盘导航顺序沿 DOM 序（各档从左到右），上下方向键在视觉上是左右移动，读屏按 menuitemradio 播报选中态。
