# Agent Note: 个人 durable 服务检查复用固定 helper

Status: implemented

## 问题

[个人迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)需要保留服务管理，但旧 `service-tools.ts` 绑定 Task、ApprovalGate 和 ArtifactStore。直接搬入会让新个人端继续依赖旧运行权威；先开放 restart 又缺少 durable 工作归属、审批消费与未知效果暂停。

## 决定

先复用固定 helper 的只读 inspect，传输与应答类型提取到同 app 的 `service-helper.ts`，两种装配共同调用。只有拥有者配置的宿主代码能够提供 helper/sudo/策略路径，模型只选服务单元；不因此提供服务重启或自由命令。

新工具原始 stdout/stderr 以 durable entries 保存，base64 保留字节，总计最多 1 MiB；超限停止检查，保存截断标记，报错而不报告状态。模型收到固定状态、观察时间和证据编号，`read_service_inspection` 以每页 4096 字符读取本会话已提交原文，不再访问服务。异常字段、非 JSON 或多条应答前缀均拒绝，失败同样保存有界捕获；存储失败由 Harness 关闭，不能生成成功结果。

inspect 无写入效果，`replay: safe` 允许恢复后重新观察，当前策略和目标仍由 helper 逐次核对。宿主配置的 helper/sudo/策略路径与 useSudo 以固定字段哈希保存于 `ruukoto.service-config` document，缺配置、改路径、不支持的 document 版本或已启用扩展丢失配置记录均在 resume 前拒绝。不固定活动态和策略内容，不能把过去观察当当前状态。配置对象复制后装配，调用方后续改对象不能换入口。

独立 `personal-service-inspect` 扩展名进入会话配置，让旧程序按缺扩展拒绝新档案。空工具档案只能在无未决输入/任务时启用检查，且已有主会话显式 configure；不会依赖 root 创建参数改写已有会话。服务检查由可信宿主 API 或[停机向导](2026-10-17-personal-service-configuration.md)显式启用。

## 既有笔记审计

按 service/helper、durable、服务管理和停止核实检索 active notes；rejected 目录不存在。[固定 helper](2026-10-03-service-management-helper.md)与[长期授权](../feature/2026-10-03-standing-permissions.md)部分重叠，其协议与写入授权约束继续适用；本任务不改变它们。[档案基础](2026-10-17-personal-durable-foundation.md)和[本机管理](2026-10-17-personal-local-management.md)部分重叠，本任务扩展可信 API，现有向导仍为空工具。无完全吸收或待归档笔记。

## 备选方案

- 直接复用旧服务工具：已有审批与产物支持，但依赖旧 Task/Store/SDK，违背迁移的运行权威边界。
- 同时接入 restart：可以一次验证审批和服务操作，但主会话尚无 durable 工作归属，无法证明未知效果只暂停所属工作；先完成只读垂直调用。
- 每次恢复读取最新 helper 配置：配置更灵活，但会改变尚未完成调用的目标或执行身份，因此固定配置并在差异时拒绝恢复。

## 后果

减少新个人端对旧 Task、审批与产物库的依赖，同时与旧工具共享真实 helper 传输。代价是持久原始输出、一个配置指纹及独立扩展引用；服务配置由停机向导首次固定，安全更新流程仍由迁移后续切片完成，不能通过删配置记录来绕开恢复检查。

只读调用可在崩溃后重复执行，观察时间和状态可能变化；不报告未落盘的成功，超限捕获不是完整结果。helper 被后台强杀留下时不据此宣称进程已停止，本任务没有有副作用操作、停止未核实占用或工作隔离的验收结论。状态不等于业务健康，sudo 与真实白名单仍由部署持有。

验证与当前环境缺口见[窄工单](../../../../.scratch/personal-pi-durable/issues/04-service-inspect.md)。离线测试覆盖真实 SQLite、替身模型、真实子进程及强杀重开；真实 Linux helper 与部署版本证据分开记录，不能代替运行中测试服务或完整服务管理验收。
