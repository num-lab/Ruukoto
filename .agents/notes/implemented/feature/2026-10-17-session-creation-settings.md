# Agent Note: 新会话继承点击时的设置

Status: implemented

## 问题

Desktop 新建会话只传目录，后台使用默认模式和模型，丢失当前 mode、model 和 effort。

## 决定

create_session／open_workspace 接受可选初始 mode 和 model_selection，thinkingLevel 继续表达 effort；Store 与 session.created 同事务保存，无schema变化，协议升为30。Desktop 点击时复制当前或最近 Code 来源，跨工作区沿用，关闭最后标签仍记住，换实例清除；PA 前台不复制远端模型。设置保存中或结果未知时阻止创建和恢复队列，提示核实；恢复队列不确认设置，不能覆盖同会话的设置未知标记。未决创建固定原键与原设置，重放先返回首次成果，不覆盖后来选择。需求与验证入口见[工单20](../../../../.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md)。

## 既有决定

检索 Desktop、Tab、消息渲染、文件预览、产物、会话默认设置的 implemented／proposed／rejected；与[既有迁移](../architecture/2026-10-17-desktop-demo-v4.md)部分重叠，本篇补充对应生命周期与读取／创建语义，其余迁移约定继续适用。其他命中无关。

## 备选方案

创建后再 set 模式和模型无需扩创建参数，但引入部分成功、闪烁和应答未知窗口；初始事务最小且一致。新增全局偏好文件可以跨重启保留，但不属于本轮要求，仅在当前连接记住最近Code来源。

## 后果

三种创建入口、四模式、非默认模型与effort、保存中／未知、重放和实例切换有回归。首次显式模型无效拒绝且不留下空工作区，省略参数的CLI/TUI保持旧默认。桌面端与后台需匹配协议30。
