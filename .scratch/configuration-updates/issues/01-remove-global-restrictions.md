# 01 解除配置更新的全局停机与永久绑定限制

Status: ready-for-agent

## 目标与边界

完成[规格 R1–R8](../spec.md#目标与范围)，保留[共同契约](../spec.md#共同契约)中的身份、权限、原操作和历史恢复要求。拥有者在 2026-10-25 先要求审查限制，再确认去除清单并要求制定方案，方案交付后明确要求提交；本次只提交方案、工单与独立审查记录，不改运行代码、不推送、不部署。

角色为方案者。该任务涉及在线更新、跨文件保存、远程协议和旧档案迁移，按重流程；本工单为唯一实施入口，不复用已 resolved 的 desktop-settings 工单作为新授权。旧全局空闲/停机约定由本方案提出收窄，理由和互链见[决策提案](../../../.agents/notes/proposed/architecture/2026-10-25-operation-scoped-configuration.md)。

## 方案

### 实施顺序

| 阶段 | 交付内容与删除对象 | 前置 | 验收 |
| --- | --- | --- | --- |
| 1 | CLI 只读走在线查询；Code 模型目录只对执行变化检查任务占用；纠正 rg 提示。删除查看入口的提前取锁和展示字段造成的占用 | 方案审查完成 | A1、A6、A12 的 rg |
| 2 | MCP 停用/删除只校验需要的新凭据，保存其他服务不依赖未修改项的旧凭据；不改未知外部效果或授权规则 | 方案审查完成，可与 1 分副本实施 | A4 的凭据 |
| 3 | 设置写意图/保存/生效回执、在线/离线共用入口、格式迁移、remote 和两壳 UI；以 Skills 接通完整链路。删除新操作统一停存启和 renderer 全局 writable 条件 | 1、2 的协议/数据边界确认 | A2、A3 的 Skills、A10、A11 |
| 4 | 模型 provider 与所有消费者按请求选择；MCP 按服务切换，连续改名通过保存历史证明兼容；PA 搜索独立更新。删除启动 options 长期捕获和与无关配置的整包比较 | 3 的完整在线/离线保存版本链 | A3、A4、A5、A7 |
| 5 | Telegram/QQ 平台级在线启停与换绑，迁移全部收发/提问/汇报调用方；停止旧入口代次自动失效仍保留 | 3、4 的来源/请求绑定 | A8 |
| 6 | 命令/服务历史配置版本、同机候选迁移与相关占用；删除终态历史依赖 current 和另建档案要求 | 3；与 4、5 汇总核对恢复顺序 | A9、A11 |
| 7 | 合并后独立实现审查、两壳和 Linux/真实模型/IM 验收、文档更新、删除仅用于新保存的旧维护分支 | 1–6 | A1–A12 |

每阶段可独立提交审查，但阶段 3 未完成前不得把新 UI 保存按钮接到无法生效的文件写入。旧维护回执的解析/核实分支保留，不能为删代码破坏已保存未启动的现场。所有实现共享工作区时单一写入者；并行实施须独立工作副本，汇总后重新确定验证范围。

### 调用方与文件清单

| 范围 | 入口、持有者与必查消费者 |
| --- | --- |
| 个人保存/格式 | apps/ruukoto/src/personal-settings.ts、personal-config.ts、personal-skills-config.ts、personal-mcp-config.ts、personal-tools-config.ts、personal-profile.ts、personal-config-idle.ts；新回执/版本只在这些既有归属内补必要具名记录 |
| 在线与远程 | personal-control.ts、personal-harness.ts、personal-remote.ts、personal-remote-maintenance.ts、personal-remote-storage.ts、personal-maintenance.ts；在线不能调用另开 Storage 的原离线空闲扫描 |
| 桌面桥和页面 | apps/desktop/src/main/personal-settings-controller.ts、personal-controller.ts；shared/personal-settings.ts、renderer/personal-settings-state.ts、personal-settings-pages.ts、settings-state.ts；packages/view/src/personal-protocol.ts 的纯 wire 类型按需扩展 |
| CLI | personal-cli.ts、personal-skills-cli.ts、personal-mcp-cli.ts、personal-tools-cli.ts、personal-qq-cli.ts 及已有服务/命令向导；普通用户不输入版本或请求键 |
| 模型与技能 | personal-model.ts、personal-skills.ts、personal-tools.ts 的自动审查、personal-harness.ts 的主/子/定时/新工作/图片配置；packages/runtime/src/models.ts、packages/agent/src/driver.ts 和 Code 桌面模型调用 |
| MCP/搜索/计划 | personal-mcp.ts、personal-tools.ts、personal-cua-linux.ts、personal-schedule-scope.ts、personal-scheduler.ts、personal-source.ts、personal-app-data.ts；既有原 generation/来源检查逐一分类，不能全删 |
| IM | personal-control.ts、personal-harness.ts、personal-telegram.ts、personal-telegram-config.ts、personal-qq-api.ts、personal-questions.ts、personal-report.ts、personal-schedule-execution.ts 与配对向导；所有捕获 QQ API 的调用方必须检索完 |
| 迁移 | personal-command-config.ts、personal-command-work.ts、personal-command-execution.ts、personal-background-processes.ts、personal-service-config.ts、personal-services.ts、personal-service-operations.ts、personal-harness.ts；目录认领、长期授权和计划范围一起复核 |
| 诊断 | personal-file-search.ts、packages/agent/src/tool-worker/file-search.ts；只复用现有发现能力 |

以上为当前检出的导航，不是允许遗漏新增调用方的固定白名单。动手前按符号查所有调用方、exports、夹具和动态引用；包间依赖沿现有 exports，不引入个人/Code 反向运行时依赖。工具结果或诊断变化按 agent-facing-text 和 prose-standard，模型所见新配置版本/选择可由会话记录重建。

### 工程验证

先为每处行为写会被旧限制拦住的最窄回归；原来断言无关阻塞的测试随规格替换，保留认证、冲突、未知效果、证据失败和旧引用负例。测试通过仅证明被测环境；阶段 3/4 的保存与 SDK 发布需要故障注入和真实本地 socket，不能只测 renderer 替身。

| 阶段 | 最小现有入口，按实际改动补窄用例 |
| --- | --- |
| 1 | npx tsx --test test/personal-cli.test.ts test/31-model-config.test.ts；rg 复用文件检索相关测试 |
| 2 | npx tsx --test test/personal-mcp-config.test.ts test/personal-settings.test.ts test/personal-mcp-recovery.test.ts；保留启用/换认证与未知效果的拒绝用例 |
| 3 | npx tsx --test test/personal-settings.test.ts test/personal-settings-blockers.test.ts test/personal-skills.test.ts test/personal-remote-maintenance.test.ts test/personal-remote.test.ts test/desktop-personal-settings.test.ts test/desktop-personal-settings-pages.test.ts；补实际文件替换/崩溃点与迁移测试 |
| 4 | npx tsx --test test/personal-durable.test.ts test/personal-media.test.ts test/personal-tools.test.ts test/personal-tools-config.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-cua.test.ts test/personal-scheduler-integration.test.ts；补 provider 换代/冷恢复及真实 verifyPersonalScheduleScope 的连续改名、离线改回用例 |
| 5 | npx tsx --test test/personal-telegram.test.ts test/personal-qq.test.ts test/personal-telegram-permissions.test.ts test/personal-scheduler-authority.test.ts；提问/回报/发送相关测试按符号检索加入 |
| 6 | npx tsx --test test/personal-command-config.test.ts test/personal-command-work.test.ts test/personal-command-execution.test.ts test/personal-services.test.ts test/personal-service-operations.test.ts；后台进程、目录认领、helper 停止核实追加实际窄测试 |
| 汇总 | npm run check:static；相关远程认证、桌面恢复、构建与两壳测试按 pre-push-checks 选取，不因“收尾”机械全量 |

实现需要 Linux 的命令/后台/helper 测试在 ssh tx 的隔离副本运行，保留源代码指纹及日志。真实模型必须 RUN_MODEL_CHECK=1 且有明确临时档案与凭据；真实 Telegram/QQ 换绑用受控测试账号，不能操作日常绑定。Electron/MyGo 的保存、草稿、断线、离线与等待生效做真实交互验收；缺前提记待验证，不记通过。新版本升级可有一次正常程序重启，不把部署升级重启误算成每次配置保存必须重启。

### 文档与旧决定

实现同批更新 docs/modules/personal-durable.md、desktop.md、runtime.md 及 docs/usage.md；模块职责变动时更新 docs/architecture.md。CLI 命令/入口实际变动时同步 README.md、docs/development.md、pre-push-checks 中受影响条目，不能提前把方案写成已实现用法。旧笔记保留原决定并互链新决定；提案分阶段落地时准确记录完成范围，不把整篇提前标为 implemented。恢复规则、格式与协议的细化决定在实施前同一入口补齐并复审。

## 进展与交接

- 当前角色与阶段：方案者已完成交接；独立 configuration_plan_review 已直接核对规格、源码与失败时序，六项意见修订后复审通过，无未解决阻断。
- 当前内容：方案编制与审查基点为 991820a74304aa4d017a99bad70338adb8087fc0；本次提交仅含本目录、决策提案及相关旧笔记的提案链接。审查证据中的 SHA-256 清单分别记录审查稿、交付状态同步与提交授权同步；实施内容保持不变。
- 下一角色与动作：实施者从阶段 1、2 开始，按阶段依赖推进并独立审查；本轮只交付方案，不自动进入实现。目标和边界已确认，不需要重新询问是否保留已写明的安全约束。
- 阻塞与恢复条件：无待拥有者拍板的目标或范围；真实 Linux/模型/IM/两壳前提属于实施验收条件，尚未执行。

## 验收与证据

方案验收：2026-10-25 独立审查通过，覆盖已确认的全部解除项、必要保留项、历史兼容、保存/生效失败、阶段依赖和最窄验证。审查者亲验公共 createSession 的无根初始化路径；审查对象、结论、文件指纹及文档检查记录在[方案审查](../evidence/plan-review.md)。

工程验收：未实施、待验证。此前调查中的测试只证明旧限制存在，不计作新行为通过。产品验收：待实施后验收普通保存、停用坏服务、目标级等待生效和迁移交互；不要求拥有者手动管理内部 ID/版本，也不以技术提示堆满页面。

## Comments

2026-10-25，拥有者要求制定方案，范围按连续对话中的去除/保留清单固定。本轮交付可审查方案，未获部署或修改日常实例的指令。

2026-10-25，独立方案审查要求补齐版本化 provider、离线无根初始化、共享 MCP 文件的保存/生效分离、StorageFailed 归属、迁移标记顺序与离线中间配置的历史。方案者完成修订，审查者按最终规格复核通过；交付仅同步本工单状态和证据，不改变已审实施内容。

2026-10-25，拥有者在方案交付后明确要求“提交”；授权仅用于提交已审方案资料，未开始实施、推送或部署。
