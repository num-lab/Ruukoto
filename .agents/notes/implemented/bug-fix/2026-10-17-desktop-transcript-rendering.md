# Agent Note: 已加载消息的渲染成本

Status: implemented

## 问题

每条消息为内联路径引用重新读取有序 flow，50条消息触发52次全量排序；整段更新又重复解析旧 Markdown，屏外占位延后已加载行的布局。

## 决定

Conversation 每次只取一次有序列表，单遍记录各消息之前的工具边界；Markdown 按最终正文与路径引用签名缓存。签名含工具 key、entryId、name、target，点击回查当前工具；附件与子会话输入变化仍更新。主／子消息行取消 content-visibility:auto 占位，保留官方滚动与 prepend 锚定。 需求与验证入口见[工单20](../../../../.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md)。

## 既有决定

检索 Desktop、Tab、消息渲染、文件预览、产物、会话默认设置的 implemented／proposed／rejected；与[既有迁移](../architecture/2026-10-16-desktop-trace-migration.md)部分重叠，本篇补充对应生命周期与读取／创建语义，其余迁移约定继续适用。其他命中无关。

## 备选方案

全局事件投影缓存可减少所有调用，但扩大共享状态失效面；只在渲染消费层去掉重复扫描。整条消息按对象缓存更短，但投影有原地变化，会漏正文或工具身份更新。

## 后果

SSR 计数和组件重放分别核实线性读取及缓存失效，性能耗时与真实绘制分开记录。保持更多行布局会增加超长历史的布局占用，未来按实测再考虑有足够预绘制的虚拟列表。
