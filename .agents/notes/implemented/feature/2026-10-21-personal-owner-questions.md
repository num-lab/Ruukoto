# Agent Note: 个人问题以真实答复来源续接主会话

Status: implemented

## 问题

个人 main 共用输入队列，工具内等待答案会占住接收答案的通路；普通聊天没有问题版本、原入口与消费事实。Coding 的问题表、Task Store 和控制协议不属于个人 durable，不能为复用工具而重新装配它们。

## 决定

`personal-questions` 独立保存问题 document、创建 entry、答复 admission 和唯一后台续接 Task。`ask_user` 非阻塞返回，每会话一批待答；同宿主工具重取原结果。模型的本轮资格按原生输入引用收窄，仅保留后台状态与输出查询。Pi 每轮工具后会换 generation Task，初次 generation 不能代表完整拥有者轮；当前 `LiveDoc.run.inputs` 与问题保存的输入交集才是依据。`personal-tool-policy` 在 provider 准备时筛选全部 `system.toolsAdded`，规范输入与 payload 两个记录边界复核，工具 hook 再拒绝未获准调用；普通后续输入不继承本轮收窄。

个人沿 Coding 已落地的纯参数解析，支持单选、多选、选项说明与推荐、自由输入、Skip 和整批跳过。此决定取代[共享提案](../../proposed/feature/2026-10-21-persistent-owner-questions.md)关于个人首版仅单选或自由文本的限制；推荐不预选，空答案不附选择字段。业务回答不提供工具批准。

回答与唯一 Task 在同一个 durable commit 保存，续接以 `personal-question:<task>` 固定键向 main admission，崩溃恢复只重接原 Submission。新 entry 使用 `ruukoto.question-answer`，原题、选项和实际答案原样可重建；`personal-source` 显式核实新来源、admission、Task、原 Submission/Inbox 和真实答复权限。工具、委派、追加、服务、报告、定时及浏览器按这一来源取原权限和入口，不伪造 IM 原文、不落默认权限兜底。实际模型请求仍由原记录器持久保存。

本机菜单逐题作答并核对，发送前保存原参数与稳定键，应答丢失先查原回执。IM 仅从已送达原宿主菜单作答，草稿及每步选择持久保存；题目、选项和整批核对按每页3000字符完整分页，确认只能回复末页菜单，列表只是有界预览，已答记录也完整分页；平台、账号、owner、代次及菜单反链逐条恢复核实。答案固定答复时权限和原入口，可信本机可查询与取消 IM 问题，不能替另一入口作答。后台续接完整答案的发送沿 `pending/sending/sent/effect_unknown`，未知发送重开不重发、不改送其他平台。

普通聊天、自然结束、断线和重开保留待答；原输入显式中止或 IM 换代使未答问题失效。问题、回执、创建和答案 entry、原工具与后台 Task 双向核对，完整反扫不可改 entries，索引与 document 一起缺失也不能隐藏原问题。原 assistant 参数先按实际工具 schema 重做 SDK 规范化再核对，允许 SDK 已接纳的数字/布尔值转换。新扩展使旧程序拒绝未知归属，首次装配前仍有旧未决工作则拒绝启用；配置向导也识别待答问题。

## 既有笔记审计

[共享提案](../../proposed/feature/2026-10-21-persistent-owner-questions.md)的个人实现及题型限制由本篇取代，共享幂等、状态和审批区别继续保留；[Coding 问题](2026-10-21-coding-owner-questions.md)与[题型扩展](2026-10-21-owner-question-choice-types.md)部分重叠，仅复用纯参数与交互语义。[个人原入口](../architecture/2026-10-17-personal-telegram-entry.md)、[本机管理](../architecture/2026-10-17-personal-local-management.md)及[报告](../architecture/2026-10-17-personal-delegation-reports.md)继续持有原接纳、停止与未知发送规则，不由本篇取代。

## 备选方案

直接复用 Coding 存储和控制协议可减少表面接线，但会引入被个人装配排除的旧 Store/runtime，故独立 durable。把答案当旧 IM 正文可少改调用方，却丢掉控制收件与实际答案身份，故新增明确来源并同步所有调用方。永久改 AgentDoc 工具名单容易实现收窄，但会限制待答期间的普通聊天，故按每次请求的原输入派生资格。只保存最终确认菜单可以少写恢复检查，却无法识别前一题草稿被替换，故每步沿原收件重建。

## 后果

新增一次后续模型请求与独立后台 Task，主聊天在待答期间继续。问题及原答案保留，不能通过删除记录解除待答。离线持久化、调用门、真实 socket CLI、两平台模拟菜单与双边界负例分别验证；真实模型及真实 QQ/Telegram 凭据验证另记工单，模拟菜单不代表真实平台验收。
