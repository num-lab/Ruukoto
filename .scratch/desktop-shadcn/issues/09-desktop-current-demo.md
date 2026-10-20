# Desktop 同步本轮 demo

Status: ready-for-human

## 目标与授权

拥有者要求「把调整同步到desktop」，迁移当前 demo 相对上轮正式迁移后的全部调整：Enter 发送／Shift+Enter 换行、文件源码高亮、筛选与折叠动画、覆盖式标签关闭键与短分隔线、无思维链正文的 Trace 工具详情、真实 Thinking／Working 执行尾部。沿用布局样式交互一致、不新增内容及必要最小后台接线授权；迁移阶段不提交、不推送、不重启日常实例。验收完成后拥有者追加「提交」，授权本地提交，仍不推送或重启日常实例。

## 方案与边界

实施前冻结 approved-demo-v3 与哈希，旧两版不变。复制新 CSS、主题、CodeBlock 和高亮器，仅追加原生窗口／真实 Markdown 适配；保留四模式、模型／Effort、Context、附件、审批、队列、核实恢复和右栏现有行为。工作区动画保留过滤强制展开与键盘焦点；Enter 忽略 IME／重复事件，空输入不停止任务，发送资格沿实际附件与写入锁。

工具按原始流的连续批次与 taskId 分组，隐藏 thinking 正文但保留其分组边界与落盘记录。Read 不展开，路径按来源 session.cwdReal 解析，落在已登记工作区内才通过现有只读接口打开；域外明确不可预览，不用同名路径替代。Edit／Write 在原行内展开真实落盘 patch，Bash 显示完整命令、输出与错误；失败标红，未知效果不冒充成功。缺失、空内容、分页、读取失败均有明确状态；通用工具和 Agent 接线保留。

复用现有 read_tool_result 字段分页，改为可供右栏与消息流复用的单次调用缓存；展开才读取，缓存按来源会话、调用和实例隔离，断线／快照／关闭的在途响应不能污染新状态。长 Bash 参数复用 get_tool_op_params 并加入 Code IPC 只读白名单，逐页校验 UTF-8 字节连续性，完成后才解析 JSON，缺少身份时明确不可用。Read 错误按需读取已有结果，不为详情重新执行工具。

Write 复用 worker 已有写前读取和 generateUnifiedPatch，把既有 patch 随 details 保存；core 将既有 patch 字段扩至 Write，保留 writeContent 兼容。新增展示字段若使最终 JSON worker 帧超过 4 MiB，省略 patch，保留真实写入成功与统计；不截断伪装完整 diff，不额外读取文件。旧历史或未捕获 patch 明示无 diff；空 patch 是无变化。核对协议兼容规则，不新增持久化 schema。

执行尾部来自真实在线任务：running 且未请求取消／未暂停／未等待审批，未结束 task.thinking 显示 Thinking；存在当前批次运行中工具显示 Working 和本批次已完成／进行中行，历史不重复展示。同一会话任务尾部键稳定，完成即回历史；不以无工具或任务 active 猜测思考，不迁 demo 场景和假数据。历史补页与跟随统一交给官方 Message Scroller，根仅防重入读取历史；采用同版 autoScroll、start 与 prepend 锚点，不混用手写 scrollTop。

实际 Electron 验收确认 SDK 在每条 toolResult message_end 后落盘，而 Driver 只到 turn_end 才补 output_entry；同批后续工具运行时已完成行无法读详情。受影响方案增量为在 toolResult message_end 后下一拍扫描已落盘条目并发引用，沿 task marker 与 flushedEntryIds 去重，扫描入口核实 managedTaskId 仍相同，允许任务刚结束后的同代兜底；保留结束兜底，不提前猜条目身份。真实双工具门控回归证明第二条仍运行时第一条已能读取；此增量独立方案复审、真实门控与旧任务代次回归、Electron 复验均通过。

实际底部跟随复验发现懒尺寸自动 scroll 被根几何判定误作用户上翻，留下 69px 缺口；逐帧诊断中无 wheel／触摸／键盘输入。独立方案复审通过后删除手动跟随与 ResizeObserver，采用官方单一控制者；初始加载占位移出 Content，避免先消费 start。最终 Electron 重新验初始 start、补页锚点、上翻不抢位置、重复底部跟随与折叠。

## 分工与文档

根代理是当前 checkout 唯一写入者；后台补丁可在独立工作副本实施，审查者只读。实施前独立方案审查，完成后独立实现与证据审查。新决定部分取代 v2 的 thinking 展示与工具详情决定，保留旧笔记理由并互链；同步 desktop、execution、agent-tools、core 的受影响说明和测试导航。后台暂缓能力清单不变。

## 验收

定向覆盖 Enter／IME／附件／空输入、真实任务阶段与分组、Read 路径含子会话工作目录和越界、工具详情完整参数／错误／分页／迟到响应、Write 新建／覆盖／空 diff／缺失／帧上限。更新冻结来源断言，源码高亮验证保留原文与转义。运行 Desktop 直系回归、相关 worker／history 用例、check:static、demo check、生产构建与签名，不机械跑全仓 check。

实际隔离 Electron 使用独立 userData 与真实 Runtime／ControlServer、本地确定性模型及工具；验收明暗／窄栏、Enter、筛选与折叠动画、标签 hover、真实文件高亮、Read、inline diff、长命令及错误、Thinking／Working 转换、审批停止、滚动补页和跟随。材料注明内容版本、环境和未验证项；真实外部模型／SSH 无前提不记通过。工程通过后交拥有者看观感。

## 进展

实现与独立增量审查均已完成；真实 Electron 三轮复验通过，包含逐条落盘与滚动两项实际缺陷的修复。Write 在独立工作副本实施后精确合入，根代理始终为本 checkout 唯一写入者。最终范围与材料独立复核通过，无阻断；产品主观观感交拥有者审阅。

## 验收与交接

[工程验收](../evidence/2026-10-16/migration-v3/engineering-verification.md)记录定向检查与独立负例；[真实 Electron 验收](../evidence/2026-10-16/migration-v3/verification.md)记录内容版本、操作、截图和限制。旧两版冻结未变，v3 共 45 文件。日常应用／后台未重启，未推送；按追加授权创建本地提交，复用已通过的行为验收并运行正常提交钩子。构建已更新并通过签名，更新后的后台才能提供新 Write patch 与逐条结果通知。
