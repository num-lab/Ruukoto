# Agent Note: durable 服务检查先持久归属再核实原执行

Status: implemented

## 问题

[helper 身份协议](2026-10-17-service-inspection-identity.md)能核实固定检查退出，但[个人只读工具](2026-10-17-personal-service-inspect.md)与[服务操作](2026-10-17-personal-service-operations.md)的审批快照仍调用无身份 inspect。后台强杀后直接重放，会留下无法归属的旧检查；未消费服务批准也不代表检查进程已停。

## 决定

两处消费者共用 app 内检查实现，以原工具 Task 或服务 Task 为稳定键，使用 session family document 保存当前尝试，不新增 Task 状态机。启动前同 commit 保存机器、检查 ID、会话、来源 Submission、Task 与接纳 entry，未核实索引只保存仍占用的 Task。工具保存原 generation 的完整输入集合，允许多输入与宿主报告查询；服务检查绑定原操作输入。机器参数来自宿主策略，helper 独立核本机，策略正文不能提供停止证明。

结果证据绑定原尝试和接纳。正常返回也必须保存原 ID 的可信停止应答；已有结果与证明可直接复用原观察，没有结果则先核实旧执行，后续 invocation 才可新建观察。每次 invocation 至多派发一次 inspect-op；异步结果按原机器、检查 ID 和接纳 entry 比对后提交，迟到应答只留证据，不更改后续尝试或占用。

停止观察用独立有界调用，记录通过 Harness 提交，不依赖已取消的工具 invocation。取消、faulted 或其他原生终态不清未核实索引；同服务目标或同来源的检查、restart、委派及子模型请求继续受阻，其他来源和目标可继续。可信宿主可列未决检查并重核停止；启动在 resume 前核实版本、最新接纳、Task、原输入、结果和停止证据，再对未决原 ID 做一次停止观察。原 prepare 取消仍核实检查，不将未消费批准当作停止证明。报告暂停引用区分旧服务操作键与检查 Task/接纳，分别监听对应 document；恢复按不可改接纳核实检查来源，不要求历史暂停仍对应当前尝试。解除检查占用可自动唤醒报告，HTTP 前拦截仍只安全重做模型汇总。

服务配置 document 使用版本 2，新扩展写入主会话；新旧程序拒绝无法解释的服务档案，不猜测无身份旧检查。旧正式个人/Coding 装配继续使用原协议。新协议不支持、应答身份不符或无法证明退出时保留占用，不回退 inspect，不开放子工具。

## 子工具的后续边界

本篇原空工具边界中的固定只读检查由[子工作检查归属](2026-10-17-personal-subagent-inspection.md)部分取代；未配置服务仍为空工具，写操作、任意命令与 MCP 不下放。原工作生命周期、来源授权及 helper 停止证明的其余决定保持。

## 既有笔记审计

按 durable、service、inspect、停止核实检索 proposed/implemented/rejected。迁移提案、只读检查、服务操作、helper 退出及检查身份协议部分重叠，分别保留产品要求、审批消费与 OS 证明；本篇取代只读检查中无身份自动重放的个人 durable 接线，其他边界保持。没有完全吸收或过时提案。早期笔记保留原决定并互链，不将其原语验收扩大为完整迁移通过。

## 备选方案

- 每次 replay 使用新随机 ID：调用实现最短，但无法证明旧检查退出，也不能阻止换 Task 绕过占用。
- 将检查另建自定义后台 Task：可以复用原生 checkpoint，但两个消费者已有稳定 Task；额外 Task 增加取消与结果归属关系，当前不需要。
- 在工具 finally 中使用原 api.commit：容易与工具结果一起收尾，但 SDK 在 abort mark、关闭或终态后拒绝原 invocation 提交，不能持有取消后的停止证据。
- 把检查记录放 task scope：自动清理方便，但 Task 终态会退役 document，恰好丢失必须保留的未核实占用。

## 后果

只读检查仍无写入效果，但可重放须先证明原执行停止。代价是接纳、证据、session 记录和恢复核对；顽固进程、旧 helper 或损坏认领可能长期保守阻塞，需要运维恢复原部署并核实。可信宿主的停止查询不增加强制释放入口，CLI/Telegram 的固定检查重核入口见[拥有者检查控制](2026-10-17-personal-inspection-stop-controls.md)，其余全面操作与真实平台体验继续由迁移验收。

证明仅适用于 helper 固定同组 show，不适用于任意命令、MCP 或主动脱组后代。子工具权限、整项外部执行归属、正式产品切换均不由本篇授予。实际测试、独立审查及环境缺口见[实施记录](../../../../.scratch/personal-pi-durable/issues/17-durable-inspection.md)。
