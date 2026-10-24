# Agent Note: 个人 durable 档案与请求证据先于恢复

Status: implemented

认证临时文件的允许范围见[令牌发布修复](../bug-fix/2026-10-24-personal-token-atomic-publish.md)；临时文件不成为认证来源，旧资料拒绝规则保持。

相关决定：[Personal 设置入口](../feature/2026-10-21-personal-settings.md)将可选托管技能根纳入严格档案布局与权限分类，保留本篇持锁、未知目录拒绝和历史证据要求。

## 问题

[个人端迁移方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)要求独立档案、单进程拥有者、未知版本拒绝执行及模型输入可重建。Pi 1.3.0 的 SQLite 没有进程锁，扩展名缺失会被忽略，`beforeRequest` 的普通异常也不能阻止请求；只接上 Harness 不能满足这些要求。

## 决定

基础实现集中在 `apps/ruukoto/src/personal-*.ts`，由正式个人入口、隔离测试及[本机引导管理](2026-10-17-personal-local-management.md)调用；入口与制品见[独立决定](../simplification/2026-10-18-personal-product-entry.md)。个人依赖固定 chord、pi-ai 与 pi-durable 1.3.0，Coding 的 Pi 0.85.1 保留，两个版本不交换 SDK 对象。迁移总方案仍是 proposed，本篇只持有已经实现的基础约束。

档案使用独立普通目录与严格格式标记，只接受已知普通文件和本机管理的指定 socket；旧目录、链接文件和不支持的产品、Pi、业务扩展版本均拒绝。目录为 0700，文件为 0600。`owner.sqlite` 的 EXCLUSIVE 事务持有实例锁，锁文件不删除；正常关闭和进程崩溃均由 SQLite/OS 释放锁，管理接口清理顺序由[本机引导管理](2026-10-17-personal-local-management.md)持有。该库不存运行状态。

`managed-skills` 与其他顶层私有目录共用名称分类，布局检查与锁后 chmod 不维护两份目录名单。托管根先用 lstat 拒绝链接、错误所有者与 group/other 权限；取得 EXCLUSIVE 锁后，读取配置及启动 Harness 前复用[托管内部检查](../feature/2026-10-21-managed-skills.md)，错误权限、链接和硬链接不靠 chmod 修复。缺少可选根不改 `PERSONAL_FORMAT`；私有暂存、部分临时清单和合法孤立包可重新持锁，但不成为已安装技能，也不自动删除。未知顶层与管理节点继续拒绝。

持久会话、输入、回答和请求证据只写 `personal.sqlite`。恢复调度之前先核实业务格式、所有会话的扩展引用与版本，再核实 live Task 定义版本。主会话模型在空闲时显式更新；仍有未完成工作时换模型拒绝恢复，避免把旧请求悄悄交给另一模型。首次初始化留下不完整数据库时同样拒绝，保留现场并另选空目录，不猜测缺失状态。

在 provider 边界先提交规范化输入，再在实际 API 的 `onPayload` 中提交最终请求体；两条 entry 以同一个请求键关联，保留原有 payload 改写。[后台工作](2026-10-17-personal-background-work.md)通过持久 ProviderDoc.sessionId 将证据写入实际调用会话，不把子请求混入主会话。记录失败使 provider 的调用或 HTTP 请求不发生，不依赖 hook 的异常语义。请求体不含认证头，凭据仍经环境变量解析。持久化失败由 durable 关闭 Harness，结束后释放实例锁，不在宿主循环自动重开。

## 既有笔记审计

按个人 durable、实例锁、输入快照和模型上下文检索 proposed、implemented 与 rejected。[迁移总方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)部分重叠，互链并保持未完成部分的 proposed 状态；[双产品](2026-10-02-two-agent-products.md)与[会话历史](2026-09-19-preserve-session-history.md)继续约束 Coding 与保留的旧格式资料，本次不取代。未发现需要吸收、删除或归档的其他决定。

## 备选方案

- PID 文件与删除陈旧锁：实现直观，但 PID 重用和 unlink 后不同 inode 的并发窗口需要额外协议；改用平台随连接释放的 SQLite 锁。
- 只检查任务定义或依赖 durable 报错：宿主代码少，但缺扩展会被忽略，旧业务版本也可能在当前实现下执行；恢复前逐项核实。
- 在 `beforeRequest` 写快照：最接近输入装配，但 1.3.0 会报告普通 hook 异常后继续，无法保证记录失败时零请求；改在 provider 与 HTTP payload 边界记录。
- 基础可用后立即替换 bin：可尽早使用新会话，但 IM、权限与业务工具仍未齐，违反完整能力验收后才切换的约定；基础 API 留在隔离验收范围。

## 后果

独立个人端的新历史、记忆、技能及请求参考由[个人资料归属](2026-10-18-personal-memory-skills-history.md)持有；本篇其余适用范围保留。

运行与历史继续由 durable 持有，宿主只增加档案保护和请求证据。两条请求记录会重复保存规范化输入；这是当前可审计性的存储代价。SQLite WAL/NORMAL 仅证明进程崩溃恢复，不承诺断电保留最近提交。业务工具、压缩、真实模型及 IM 的完整验收仍由后续迁移承担，基础测试不能代替它们。[服务检查](2026-10-17-personal-service-inspect.md)扩展可信宿主 API 与可重放的只读外部调用，主会话另装配[后台分析管理工具](2026-10-17-personal-model-work.md)，子会话按当前已启用能力固定工具，不继承父聊天。
