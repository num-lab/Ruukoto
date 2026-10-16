# 个人持久会话基础

## 职责与边界

`apps/ruukoto/src/personal-*.ts` 提供独立的 Pi 1.3.0 会话基础，只由隔离测试调用。正式个人 bin、根启动脚本、开发启动器与部署入口使用[产品装配](products.md)中的共享运行时；本模块没有 IM、业务工具或管理协议。

## 对外接口

`openPersonalHarness` 接受独立目录、provider 与模型，返回主会话、Harness、提交、等待回答与关闭方法。提交键由调用方保持稳定，用于 durable 会话内去重。`parsePersonalModel` 校验模型配置，`personalProvider` 按环境变量名读取凭据，支持 OpenAI Completions、OpenAI Responses 与 Anthropic Messages。个人 Pi 1.3.0 对象不传给 Coding 的 Pi 0.85.1。

## 数据与状态

目录中的 `profile.json` 标记产品、Pi、档案和业务扩展版本；`owner.sqlite` 仅持有进程锁。`personal.sqlite` 保存 durable 会话、原生任务、提交、历史、业务格式 document 与 `ruukoto.model-request` entries。请求证据保存会话来源、规范化输入、推理级别和实际请求体，两条记录以请求键关联。凭据不写入请求证据，文件权限为 0600，目录权限为 0700。

## 主要流程

启动先拒绝旧目录和链接文件，取得 SQLite EXCLUSIVE 锁并核对档案标记，再打开存储、核对业务格式与每个会话的扩展引用，最后打开 Harness 并检查 live Task 版本。检查完成才恢复调度。新主会话显式选择模型、个人提示与空工具集；已有空闲会话可更新模型，有未完成工作时拒绝换模型恢复。

提交先由 durable 持久化，再生成回答；同键重投返回原 submission。每次调用 provider 前保存规范化输入，实际 API 发出 HTTP 前保存最终请求体。回答只从已完整结束的 assistant entry 读取；进程重开恢复原会话与尚未完成的输入。

## 不变量与失败处理

同一档案只允许一个拥有者，连接关闭或进程崩溃后释放锁，锁文件不删除。不支持的版本、缺扩展或缺任务定义均阻止调度；已有数据库缺少格式记录也拒绝。输入证据写失败时不发请求；存储失败关闭 Harness 并报告，宿主不自动重开。正常关闭保留未完成输入供重开恢复，不能当作工作取消。

仅使用新的隔离目录，不能以此 API 浏览或恢复旧个人档案。SQLite WAL/NORMAL 支持进程崩溃恢复，不保证断电时最近提交保留。本模块没有提供外部操作恢复保证。

## 设计依据

- [个人 durable 档案与请求证据先于恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md)
