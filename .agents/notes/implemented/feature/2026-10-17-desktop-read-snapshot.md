# Agent Note: 工作区外 Read 的捕获版本预览

Status: implemented

256KiB展示上限由[完整分块传输](2026-10-18-complete-reasoning-and-preview.md)部分取代；捕获来源与授权契约保持。

## 问题

Read 可合法读取工作区外文件，但 Desktop 只按登记根映射路径，导致 /tmp 文件没有预览入口。

## 决定

成功 canonical read 的唯一工具产物用于 Read 捕获快照预览，现有执行链的 Read 仅捕获 file_read 一流；读取后核实 artifactId、taskId、sessionId、状态与大小，不解析人类名称。只给 Code 开放已有 read_artifact，最多展示256KiB；partial和截断可见。文件路径仅作标题与语言选择，不作为新FS读取参数。缺失／多义旧记录明确不可预览。 需求与验证入口见[工单20](../../../../.scratch/desktop-shadcn/issues/20-desktop-interaction-fixes.md)。

## 既有决定

检索 Desktop、Tab、消息渲染、文件预览、产物、会话默认设置的 implemented／proposed／rejected；与[既有迁移](../architecture/2026-10-17-desktop-demo-v4.md)部分重叠，本篇补充对应生命周期与读取／创建语义，其余迁移约定继续适用。其他命中无关。

## 备选方案

按任意绝对路径读取可展示当前版本，但新增系统路径权限且源文件可能已删除；读取已捕获产物可保留当时版本与归属，沿用后台保护。新增结构化产物kind更通用，但本轮唯一Read流契约已经足够，不改schema。

## 后果

源文件删除后仍可读取快照，伪造归属、迟到、partial与大小均有回归。零字节Read当前没有产物，仍显示缺失说明；只读捕获版本，不承诺文件当前内容。
