# 个人持久会话与本机管理

## 职责与边界

`apps/ruukoto/src/personal-*.ts` 提供独立的 Pi 1.3.0 会话及本机引导管理，只用于隔离验证。正式个人 bin、根启动脚本、开发启动器与部署入口使用[产品装配](products.md)中的共享运行时；本机向导仍为空工具会话；可信宿主 API 可单独启用只读服务检查，没有 IM、审批或有副作用的业务工具。

## 对外接口

`openPersonalHarness` 接受独立目录或已持有的 `PersonalProfileLock`、provider 与模型，接管锁的释放责任，返回主会话、Harness、提交、等待回答与关闭方法；可用 `beforeUnlock` 在放锁前收齐管理接口。可选 `service` 接受宿主固定的 helper 配置，安装 `service_inspect` 与 `read_service_inspection`，模型只能指定白名单内精确单元名或本会话的证据编号。提交键由调用方保持稳定，用于 durable 会话内去重。`parsePersonalModel` 校验模型配置，`personalProvider` 按环境变量名读取凭据。个人 Pi 1.3.0 对象不传给 Coding 的 Pi 0.85.1。

`startPersonalServer` 独占后台，HTTP 仅监听档案内 Unix socket，经本地令牌逐次认证；提供 `/status`、`/messages`、`/inputs`、`/input` 和 `/stop`。`personalControl` 为 CLI 调用；CLI 不重开 Harness。引导与前台托管见[操作手册](../usage.md#25-个人-durable-隔离向导)。

## 数据与状态

目录中的 `profile.json` 标记产品、Pi、档案和业务扩展版本；`owner.sqlite` 仅持有进程锁。`personal.sqlite` 保存 durable 会话、原生任务、提交、历史、业务格式 document、逐键输入指纹和 `ruukoto.model-request` entries。请求证据保存会话来源、规范化输入、推理级别和实际请求体，两条记录以请求键关联。凭据不写入请求证据，文件与 socket 权限为 0600，目录为 0700。

`ruukoto.service-config` document 保存 helper/sudo/策略路径与 useSudo 的指纹，`personal-service-inspect` 扩展名写入会话；旧程序缺此扩展即拒绝。`ruukoto.service-inspection` entry 保存检查目标、错误码、base64 编码的原始 stdout/stderr 与截断标记；它没有模型正文，只在读取工具结果中按需进入上下文。

`model.json` 只保存模型配置与凭据环境变量名，临时文件加 rename 保存；`control.token` 每次启动轮换，`control.sock` 只在后台持锁时清理，`backend.log` 保存后台诊断。`pending-<UUID>.json` 是客户端发送前独占创建的原键/正文，多个 CLI 不覆盖彼此；核实原 submission 后只删对应文件。它不镜像执行状态，也不授予执行资格。

## 主要流程

启动先拒绝旧目录和链接文件，取得 SQLite EXCLUSIVE 锁并核对档案标记，再打开存储、核对业务格式与每个会话的扩展引用，最后打开 Harness 并检查 live Task 版本。检查完成才恢复调度。主会话显式选择模型、个人提示及工具；未提供服务配置时为空工具。已有空闲会话可更新模型或启用服务检查，有未完成输入/任务时拒绝增加工具或换模型恢复。已启用检查的档案缺配置、指纹变化、配置版本不支持或记录缺失均在恢复前拒绝。

提交先由 durable 持久化，再生成回答；同键重投返回原 submission。每次调用 provider 前保存规范化输入，实际 API 发出 HTTP 前保存最终请求体。回答只从已完整结束的 assistant entry 读取；进程重开恢复原会话与尚未完成的输入。

本机提交先记录正文 JSON 字符串编码的 SHA-256，再调用原生 admission，同键异参拒绝。指纹提交后而 admission 前崩溃时，原 submission 查询为未受理，不自动执行；CLI 让拥有者选择原键继续或保留。应答丢失先核实，不自动重送。停止请求先完成自身应答，再停 listener、等全部 handler、关 Harness；Harness 故障关闭也完成接口清理后才放实例锁。

服务检查以固定 argv 调用共享 `service-helper.ts`，helper 逐次核实本机、当前策略和白名单。原始输出先写 durable，再返回固定状态、观察时间和证据编号；`read_service_inspection` 每页最多 4096 字符，只读本会话的指定类型 entry。模型输入证据包含实际工具定义和结果；读取原文不再次调用 helper。

## 不变量与失败处理

同一档案只允许一个拥有者，关闭清理完成或进程崩溃后释放锁，锁文件不删除。配置写入使用同一锁，不因连接失败而离线争写。不支持的版本、缺扩展或缺任务定义均阻止调度；已有数据库缺少格式记录也拒绝。输入证据写失败时不发请求；存储失败关闭 Harness 并报告，宿主不自动重开。正常关闭保留未完成输入供重开恢复，不能当作工作取消。坏令牌、链接及旧目录拒绝，不能清理后自动接管。

请求体 128 KiB、消息正文 16 KiB、应答 256 KiB；客户端总时限 5 秒，后台收件 10 秒、闲置 15 秒。最近记录扫描 64 条 entry、显示最多 16 条消息，每条最多 8192 字符并标截断/中断；不返回输入证据或堆栈。终端输出过滤控制字符。

服务检查 stdout/stderr 总计最多 1 MiB，超限停止检查并明确标记部分证据；畸形应答、多条前缀、目标或状态字段不符均报错，不把它们当状态。证据写入失败关闭 Harness，不能报告成功。服务配置不由模型、工具参数或本机消息正文决定；没有服务重启能力。

仅使用新的隔离目录，不能以此 API 浏览或恢复旧个人档案。SQLite WAL/NORMAL 支持进程崩溃恢复，不保证断电时最近提交保留。服务检查为无写入效果工具，可在中断后安全重跑并得到新的观察；不提供有副作用操作恢复保证。

## 设计依据

- [个人 durable 档案与请求证据先于恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md)
- [隔离个人实例由后台独占并通过本机接口管理](../../.agents/notes/implemented/architecture/2026-10-17-personal-local-management.md)
- [个人 durable 服务检查复用固定 helper](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-inspect.md)
