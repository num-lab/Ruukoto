# 个人 durable 接入检索、持久提问与后台进程

Status: ready-for-human

## 目标与边界

三个Coding切片已通过各自验收；拥有者2026-10-21授权接手本单，按[共享规格](../spec.md)接入个人端，保留独立durable、来源与IM代次。分别依赖[文件检索](01-coding-file-search.md)、[提问](02-coding-owner-questions.md)、[后台进程](03-coding-background-processes.md)；不是为复用而导入旧runtime/Store/ApprovalGate。

## 方案

1. 复用检索纯参数/解析，新增绑定tools资料根的只读执行适配，接personal-tools/IO/artifacts/config/harness及原权限、定时/子工作工具快照。受限递归搜索不在宿主raw spawn，也不借command目录替代资料范围。
2. 新增个人问题document/不可改entries、answer-admission及唯一续接Task；扩展personal-source和实际请求证据，在本机control/CLI及QQ/Telegram原宿主菜单实现查询、逐题回答、取消、回执与换代失效。沿固定原键接回main，不占住主聊天。
3. 主会话完全访问的显式后台工具使用command.json固定目录、独立durable执行与输出记录，复用底层机器/执行身份。新增共享目录claim，后台starting、普通命令prepare/start、文件写批准消费均事务核实并认领，持有至各自停止/观察完成，未知保留；不能只在后台启动时读一次现有命令表。不向子工作/调度开放start，旧两分钟run_command语义保留。
4. 停机配置与扩展升级先核实旧未决工作，恢复双向核对全部document/entry/Task/来源/占用；新增扩展阻止旧程序忽略记录。没有相同原生能力的平台明确不支持，不退回宿主无限制执行。
5. 更新personal-durable/agent-tools/execution/scheduler及usage中受影响说明，README/development/pre-push同步实际新增前提或入口。按能力逐个接入和验证，不把三个适配合成一次不可定位的验收。

接手时核实的最终接口：检索复用`@ruukoto/agent/file-search.ts`定义、参数、argv与解析，执行器只在个人原生只读worker内运行；不在宿主直接调用含spawn的扫描器。提问沿02最终题型接纳Skip空字符串、选项description/recommended与multiple，保存实际选择索引；使用独立个人document/entries/Task和原菜单，不导入Coding的Store工具族。后台复用`execution/background.ts`的原生身份、prepare/launch/stop，独立持久记录与claim仍由个人端持有。Coding当前schema49/协议36不作为个人格式版本；个人扩展按实际新记录递增并拒绝缺失关系。

## 进展与交接

- 当前角色：实施、文档与独立实现审查完成，等待产品环境验收；完整范围、源码SHA、检查与限制见[最终组合验收](../evidence/personal-final/README.md)。
- 已完成：文件检索、持久提问、Linux会话后台及共享目录认领汇入根；三片及组合独立审查无未解决实现阻断。真实模型沿拥有者指定的 `/Users/eitrous/.ruukoto/agent/models.json` 使用 `deepseek/deepseek-flash`，检索、提问和后台分别有实际工具闭环。
- 下一角色：拥有者或环境验收者，沿[隔离IM入口](../evidence/personal-im-preparation/README.md)补真实QQ/Telegram配对、原私聊菜单及换代验收；提供可用sandbox的Linux浏览器，补后台服务→browser访问→跨轮→停止→写入，再交独立上下文核实证据。
- 当前缺口：真实IM尚缺专用账号与凭据；Linux Chrome报 `No usable sandbox!`，本次宿主HTTP真实访问不算browser通过。不能由模拟菜单或旧Coding结论替代，也不将本单标resolved。
- 兼容边界：个人业务格式 `extensions.personal=2` 精确拒绝旧档案，不自动迁移或清空；本次只用隔离新档案。后台沿原个人Linux command配置，不扩展macOS个人后台。

## 验收与证据

工程自检包括最终static、构建及个人制品刷新、来源兼容回归202/202、受影响工具/worker/权限/委派/报告131/131、最终产品入口15/15、问题后台交集与关闭水位2/2、macOS真实原生及检索18/18；其他组合首轮的超时与失败、对应修复/重跑均原样保存在[最终检查汇总](../evidence/personal-final/README.md)，不外推首轮全通过。

Linux真实后台scope跨轮保留、停止核实、释放与重开不重放1/1；命令恢复6/6、共享claim2/2；只读检索原生2/2及durable/定时2/2。真实DeepSeek检索4请求、提问6请求、最终后台13请求四轮通过，后台另核实进程退出、HTTP关闭、cgroup为空、claim释放及隔离凭据清理；完整请求两边界和schema/systemPrompt估算均入证据。

独立 `plan_delta_review` 亲跑问题/后台及新增交集、来源返工并审查最终真实模型证据，`dependency_audit` 复核汇总接缝并亲跑Linux关键窄测，无未解决实现阻断。主观交互及必要外部环境验收仍待上节所列真实IM/browser前提；提交已获拥有者授权，未推送、部署或接管日常实例。

## Comments

2026-10-21：拥有者确认两端规划、先Coding；个人端复用底层能力而不迁回旧共享业务运行时。

2026-10-21：拥有者明确要求接手本单，授权按已审范围实施个人适配，取代原仅规划限制；未授予提交、合并、部署或改动日常档案权限。核实前三单最终接口与验收完成，删除过期依赖阻塞；题型扩展与个人来源、claim、格式恢复一并交独立复核。

2026-10-21：拥有者指定真实模型验收沿用 `/Users/eitrous/.ruukoto/agent/models.json`。实现与组合审查完成，隔离Linux后台及DeepSeek闭环通过；真实IM与browser环境缺口保留ready-for-human，恢复入口和下一责任人已列于正文。

2026-10-21：拥有者明确要求提交本单现有成果；提交范围包括实现、测试、文档和本单验收证据，不含推送、部署或日常实例接管，ready-for-human及真实IM/browser缺口保持不变。
