# 02 Code 提供方、模型与凭据管理

Status: ready-for-agent

## 目标与边界

完成[范围矩阵](../spec.md#功能与范围矩阵)的 Code 模型能力及 R2–R5，区别实例默认与会话模型。前置：[01](01-settings-shell.md)。复用现有模型配置，不新增模型注册平台或替代存储。

## 方案

1. 在 `packages/control/src/ops.ts` 为已有 `get_model_config`、`save_model_catalog`、`set_model_api_key`、`remove_model_api_key`、`remove_model_provider`、`set_default_model`、`set_summary_model`、`test_model_connection` 补准确请求/响应类型；`apps/desktop/src/main/ipc.ts` 只对 Code 放行所需项。保留 `credentials[provider].configured` 及 set/remove 响应的现有字段语义：仅表示 auth.json 中该提供方存储条目存在，不代表全部来源或认证可用。
2. `Runtime.getModelConfig` 补脱敏的已配置位置元数据：存储条目及 api_key/OAuth 类型、目录 apiKey、自定义请求头的具体 provider/model/modelOverrides 位置；并提供设置选择器需要的已配置模型成员、名称与真实 thinkingLevels 纯元数据，不触发认证解析。请求头存在仅说明可能含认证，不证明有效；运行时覆盖只在 SDK 可直接确认存在时显示，环境或 SDK 来源无可靠元数据时显示「来源或有效性未验证」。共享文件元数据逻辑沿 `model-config.ts`，不复制 SDK 优先级解析器；设置列表不调用 getAuth/checkAuth/refresh，不为读状态展开环境模板、执行凭据命令、刷新 OAuth 或联网，也不把旧 SDK snapshot 的「未配置」解释为无来源。
3. 设置模型页按提供方→模型详情渐进操作，支持增改删、API 类型/地址、高级 headers、模型容量/图片/推理能力。操作明确分来源：「保存存储 API Key」「移除存储凭据」仅用既有 set/remove 接口；原存储条目为 OAuth 时明确该条目将被替换/移除，不宣称撤销远端令牌。目录 apiKey 或具体 header 的替换/清除须显式选择字段并走 save_model_catalog，保留其他来源、未展示高级字段和脱敏占位符；环境来源只提供后台启动环境的修改指引，不修改 process.env。秘密提交后清空。
4. 加后台默认模型/Effort、摘要模型选择与清除，显示被会话/默认/角色引用而不能删除、受影响 provider 忙、启动参数覆盖和字段错误；不修改既有任务选择。删除最后可用来源使现有后端重建校验失败时，沿门闩/回滚返回失败，不绕过校验。
5. 保存带当前 revision；冲突保留草稿并读回，丢答不重发。删除后读回配置位置，提示「已移除所选存储条目」并保留其他来源或未验证状态，不能显示「已无凭据」或保证提供方不可用。主动连接测试提示联网与可能费用，显示脱敏结果，保存与测试分别报告。
6. 同步 `packages/tui/src/config-tui/app.ts` 的 ModelConfigView、modelsScreen、providerScreen、providerApiKey 和在线/离线 catalogModels，以及 index.ts 的在线/离线 load 与 runConfigTui：均使用相同来源语义。设置内的默认/摘要模型选择器改从上述纯元数据取得成员与 thinkingLevels，不沿会执行 checkAuth 的 list_models 构建展示；Desktop 设置页同样适用。runConfigTui 去掉离线进入时自动 probeModelConfig 的认证求值，以结构检查与未验证状态进入界面，显式保存/连接测试仍沿原验证，不修改执行、composer 和其余调用方的认证检查。删除「移除后该提供方将因缺少凭据而不可用」的确认文案；离线不以 auth 条目决定模型能否使用，缺可证明成员/档位时明确未知或引导在线，不静默丢条目或虚构档位。
7. `code-state.ts` / `code-writes.ts` 处理 `model.config_changed`，失效并刷新会话菜单和新聊天目录；旧页迟到结果不能覆盖新目录。共享类型不得从浏览器入口运行时导入 Node 模块。
8. 同步 `docs/modules/desktop.md`、`control.md`、`agent-context.md` 和 `tui.md` 中实际变化，更新 `docs/usage.md` 的图形入口与按来源移除说明。

## 待处理审查意见

**P2：明确多来源凭据的状态与清除范围。** 当前 `Runtime.getModelConfig().credentials` 只枚举 `auth.json`，`remove_model_api_key` 仅调用 `removeProviderCredential` 删除该文件的条目，却返回 `configured: false`。复审在隔离临时目录验证：同一提供方同时存在存储密钥和 `models.json` 内联密钥时，删除前使用存储密钥，删除后模型仍会使用内联密钥。因此不能直接把该返回值显示为「已无凭据」。源码依据：[配置视图与操作](../../../packages/runtime/src/runtime.ts)、[凭据文件操作](../../../packages/agent/src/model-config.ts)。

方案者须补齐界面显示的凭据来源、替换与清除所作用的来源，以及删除后仍有内联或环境来源时的生效状态和下一动作；核对后台返回类型、桌面表单与 TUI 的含义一致。保留无关高级配置和脱敏占位符的要求仍成立，不能靠静默删除所有配置秘密修正展示。此项处理方案须复审，登记意见不等于问题已解决。

处理方案：步骤 1–3/5/6 已区分配置位置、所选来源操作与实际连接验证，补齐后端脱敏元数据和 TUI 在线/离线消费、设置选择器及离线入口；不改 SDK 解析顺序，不为列来源执行动态凭据解析。独立方案复审已通过，P2 方案阻断解除，尚无产品实现证据。

## 进展与交接

- 2026-10-21 拥有者明确表示「方案已通过」，本单范围与产品取舍已确认；ready-for-agent 表示方案可交实施，实际开工仍须满足本单前置。

- P2 独立方案复审通过，基点见总规格；尚无实现。下一角色为实施者，先核实 01 已交付及当前检出；产品取舍已获批准。
- 01 完成后可开工；P2 方案复审及拥有者批准均已完成；与 03 对 `ops.ts` / IPC 的更改在独立工作副本实施或顺序接入。
- 工程与产品验收均待完成；受审内容以文件快照记录。

## 验收与证据

- 新增 `test/desktop-settings-models.test.ts`：真实本机控制面增改读回、跨客户端 revision 冲突、忙拒绝、引用保护、丢答后核实、脱敏与目录事件刷新；使用隔离配置和模拟 provider，禁止真实模型默认联网。
- 补凭据来源回归：仅目录 apiKey、存储与目录 key 并存、存储与已知 provider 环境来源并存；删除选定来源后用合成凭据离线核对实际解析、界面状态及重开结果，其他来源字节与进程环境不变，不能误报「已无凭据」。目录环境模板缺失、目录凭据命令、OAuth 条目和无法核实的 SDK snapshot 在列表只显示已配置位置/未验证；分别打开 TUI 离线入口、在线/离线默认与摘要选择器、Desktop 设置列表，读取期间新增命令执行与 OAuth 刷新计数为零、无网络请求，不把后台初始化的历史计数算入本次读取；不能靠 mock 掉整个列表漏测 list_models/probeModelConfig 的旧求值入口。不把 auth.json 的任意 !字符串推定为命令。provider/model/modelOverrides 的单个 header 或 apiKey 清除只改变选定字段，其他高级字段与秘密占位符保留，header 不误报认证成功。响应、事件、错误及终端输出无 key/token/header 值或命令正文；落到 `test/31-model-config.test.ts`、`test/33-config-tui.test.ts` 及桌面模型用例，验证在线/离线文案和状态一致、最后凭据不可移除时原配置回滚。执行/composer 的认证校验回归仍须通过。
- 定向回归：`npx tsx --test test/31-model-config.test.ts test/33-config-tui.test.ts test/38-desktop-main.test.ts test/desktop-composer.test.ts test/desktop-session-settings.test.ts test/desktop-settings-models.test.ts`；`npm run check:static`。
- 产品验收：双壳配置后退出重开，TUI/会话菜单与后台一致；真实模型测试另需拥有者指定的测试配置与费用范围，缺前提记未验证。
- P2 修订经独立方案复审通过，见[记录](../review.md)；初审不覆盖的凭据契约以本轮复审为准，实现审查尚未进行。

## Comments

2026-10-21：后台已有管理操作，主要工作为类型、桌面接线与表单。

2026-10-21 复审：发现清除存储密钥后回退内联密钥的反例，已写入正文的 P2、修订范围与验收要求；未修改产品代码，未解除阻断。

2026-10-21 方案返修：按配置位置定义状态和操作范围，增加安全的脱敏来源读取、TUI 在线/离线同步及不解析动态凭据的验收，提交独立方案复审。

2026-10-21 返修复审补充：审查者沿真实入口发现在线设置选择器的 list_models 和 TUI 离线自动 probe 仍会求值认证；已将这两处消费路径纳入步骤 2/6 和零新增求值验收，保留执行/composer 的原认证验证。

2026-10-21 返修复审通过：独立上下文 /root/revision_review 亲验脱敏/占位、SDK 元数据与真实目录的 checkAuth 调用，核对补齐的消费路径，解除 P2 方案阻断；产品实现与验收未执行。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。
