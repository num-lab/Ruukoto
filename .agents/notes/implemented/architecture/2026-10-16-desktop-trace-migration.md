# Agent Note: Desktop 同步 Trace 详情与执行状态

Status: implemented

## 问题

拥有者要求将本轮 demo 调整同步 Desktop。新的 Trace 详情、Thinking／Working 尾部与上轮直接显示思考正文、工具点击只打开右栏的决定冲突；直接复制模拟步骤会掩盖真实任务阶段、截断参数与历史缺失。

## 决定

按[工单](../../../../.scratch/desktop-shadcn/issues/09-desktop-current-demo.md)冻结 v3；正式主题、基础 CSS、高亮器和原语追溯至冻结稿，原生窗口适配独立追加。Enter 发送保留 IME、附件和写入锁，Shift+Enter 换行；标签、筛选、工作区与 Trace 开合沿 demo。源码使用同版 highlight.js 完整文本高亮，未知语言保留 React 纯文本；不执行文件内容。

消息流不渲染思考正文，原始事件与 JSONL 不变；原始 thinking 仍分隔工具批次，工具还按 taskId 分组。在线 running、未取消／暂停／等待审批的任务才有执行尾部；未结束的 thinking 是 Thinking 的依据，当前批次存在运行中工具才是 Working。工具结果和历史关联按原调用更新，尾部按任务固定身份，已完成行不重复渲染。滚动统一由同版官方 Message Scroller 持有：autoScroll、初始 start 与原生 prepend 锚点一并启用，根只触发历史读取，不另写 scrollTop。加载与空态提示位于 Content 外，避免提前消耗初始定位；上翻阅读、懒尺寸和折叠动画沿原语模式处理。

Read 静态行的路径按来源会话 cwdReal 解析，只经已登记根的现有只读接口打开；不在范围内明确无法预览。截断路径与 Bash 命令复用 get_tool_op_params，完整参数逐页核实字节与操作／任务／会话身份后解析；异步打开绑定发起的父会话。结果复用 read_tool_result 分页与校验，inline 缓存独立于右栏选择，断线／快照淘汰在途结果。错误详情标红，未知效果不显示成功；缺失 diff 与空 diff 分开，运行中调用不借旧文件结果。

Write 在原 worker 写入回调中复用既有写前读取与 generateUnifiedPatch，将 patch 和统计一起写入工具结果。core 既有 nullable patch 字段同时读取 Edit／Write；writeContent 保留旧语义。最终 JSON worker 帧若因 patch 超过 4 MiB，只省略展示 patch，保留真实成功与统计；不额外读取文件、不截断后声称完整。不改变 wire 形状或参数，维持协议 v28，旧记录缺字段显示未记录 diff。同 worker 文件修改队列仍串行同路径调用，不承诺与外部编辑器原子比较。

每条 toolResult 的 SDK message_end 通知返回后，下一拍按已落盘 JSONL 发 output_entry；不等同批其他工具结束，不用 tool_execution_end 猜身份。扫描入口按 managedTaskId 拒绝旧任务回调，保护下一任务的引用去重集合与消息标识队列；任务刚结束但未进入新任务时仍允许原结束兜底。

本篇同时扩展[结果分页](../feature/2026-10-16-tool-result-pagination.md)的 patch 来源至 Write，原字节分页与缺失语义不变。部分取代[上轮迁移](2026-10-16-desktop-current-demo.md)的 thinking 正文与工具详情决定，其余只读权限、Context、审批、附件与恢复继续成立；[demo 工具试验](../feature/2026-10-16-demo-trace-tools.md)与[输入预览试验](../feature/2026-10-16-demo-input-preview.md)由本次正式迁移授权接入真实状态，旧冻结与证据保留。

## 备选方案

- 复制完整 demo App：迁移最快，但会把模拟执行与文件写入正式端；仅复制展示，接真实投影和已有控制面。
- 为 Write diff 再读当前文件：实现直接，但读到的是调用后的现态，不能证明历史写前版本；保存工具执行边界已有 patch。
- 所有详情复用右栏选中状态：省缓存，却使两条展开的调用互相覆盖并改变右栏；共享分页校验，保留单次调用缓存。
- 保留手动跟随并补输入来源判别：可少动原历史代码，但真实 Electron 已证明懒尺寸的自动 scroll 会被误当作用户上翻，且需重复处理 wheel／键盘／触摸／滚动条；删除手动控制，采用已有原语的完整自动跟随和补页锚点。

## 后果

工程与隔离 Electron 证据由工单持有；真实模型与 SSH 无前提不记通过。高亮增加一个限定 grammar 的构建依赖；参数与结果仅在需要详情时读取。历史缺失、写前读取失败与超帧 patch 均不能恢复 diff，界面明确报告；后台暂缓能力继续沿原清单。
