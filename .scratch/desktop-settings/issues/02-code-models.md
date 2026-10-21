# 02 Code 提供方、模型与凭据管理

Status: resolved

## 目标与边界

完成[范围矩阵](../spec.md#功能与范围矩阵)的 Code 模型能力及 R2–R5，区别实例默认与会话模型。前置：[01](01-settings-shell.md)。复用现有模型配置，不新增模型注册平台或替代存储。

## 方案

1. 在 `packages/control/src/ops.ts` 为已有 `get_model_config`、`save_model_catalog`、`set_model_api_key`、`remove_model_api_key`、`remove_model_provider`、`set_default_model`、`set_summary_model`、`test_model_connection` 补准确请求/响应类型；`apps/desktop/src/main/ipc.ts` 只对 Code 放行所需项。保留 `credentials[provider].configured` 及 set/remove 响应的现有字段语义：仅表示 auth.json 中该提供方存储条目存在，不代表全部来源或认证可用。
2. `Runtime.getModelConfig` 补脱敏的已配置位置元数据：存储条目及 api_key/OAuth 类型、目录 apiKey、自定义请求头的具体 provider/model/modelOverrides 位置；并提供设置选择器需要的已配置模型成员、名称与真实 thinkingLevels 纯元数据，不触发认证解析。请求头存在仅说明可能含认证，不证明有效；运行时覆盖只在 SDK 可直接确认存在时显示，环境或 SDK 来源无可靠元数据时显示「来源或有效性未验证」。共享文件元数据逻辑沿 `model-config.ts`，不复制 SDK 优先级解析器；设置列表不调用 getAuth/checkAuth/refresh，不为读状态展开环境模板、执行凭据命令、刷新 OAuth 或联网，也不把旧 SDK snapshot 的「未配置」解释为无来源。
3. 设置模型页在同一提供方弹窗填写连接、认证及模型字段，默认／摘要在总览直接选择并自动保存，支持增改删、API 类型/地址、高级 headers、模型容量/图片/推理能力。操作明确分来源：「保存存储 API Key」「移除存储凭据」仅用既有 set/remove 接口；原存储条目为 OAuth 时明确该条目将被替换/移除，不宣称撤销远端令牌。目录 apiKey 或具体 header 的替换/清除须显式选择字段并走 save_model_catalog，保留其他来源、未展示高级字段和脱敏占位符；环境来源只提供后台启动环境的修改指引，不修改 process.env。秘密提交后清空。
4. 加后台默认模型/Effort、摘要模型选择与清除，显示被会话/默认/角色引用而不能删除、受影响 provider 忙、启动参数覆盖和字段错误；不修改既有任务选择。删除最后可用来源使现有后端重建校验失败时，沿门闩/回滚返回失败，不绕过校验。
5. 保存带当前 revision；冲突保留草稿并读回，丢答不重发。删除后读回配置位置，提示「已移除所选存储条目」并保留其他来源或未验证状态，不能显示「已无凭据」或保证提供方不可用。主动连接测试点击即执行，不再弹确认窗或显示成功提示；模型名旁黄／绿／红点显示未测／成功／失败，失败详情遮蔽秘密，修改配置后旧结果失效。
6. 同步 `packages/tui/src/config-tui/app.ts` 的 ModelConfigView、modelsScreen、providerScreen、providerApiKey 和在线/离线 catalogModels，以及 index.ts 的在线/离线 load 与 runConfigTui：均使用相同来源语义。设置内的默认/摘要模型选择器改从上述纯元数据取得成员与 thinkingLevels，不沿会执行 checkAuth 的 list_models 构建展示；Desktop 设置页同样适用。runConfigTui 去掉离线进入时自动 probeModelConfig 的认证求值，以结构检查与未验证状态进入界面，显式保存/连接测试仍沿原验证，不修改执行、composer 和其余调用方的认证检查。删除「移除后该提供方将因缺少凭据而不可用」的确认文案；离线不以 auth 条目决定模型能否使用，缺可证明成员/档位时明确未知或引导在线，不静默丢条目或虚构档位。
7. `code-state.ts` / `code-writes.ts` 处理 `model.config_changed`，失效并刷新会话菜单和新聊天目录；旧页迟到结果不能覆盖新目录。共享类型不得从浏览器入口运行时导入 Node 模块。
8. 同步 `docs/modules/desktop.md`、`control.md`、`agent-context.md` 和 `tui.md` 中实际变化，更新 `docs/usage.md` 的图形入口与按来源移除说明。

## 待处理审查意见

**P2：明确多来源凭据的状态与清除范围。** 当前 `Runtime.getModelConfig().credentials` 只枚举 `auth.json`，`remove_model_api_key` 仅调用 `removeProviderCredential` 删除该文件的条目，却返回 `configured: false`。复审在隔离临时目录验证：同一提供方同时存在存储密钥和 `models.json` 内联密钥时，删除前使用存储密钥，删除后模型仍会使用内联密钥。因此不能直接把该返回值显示为「已无凭据」。源码依据：[配置视图与操作](../../../packages/runtime/src/runtime.ts)、[凭据文件操作](../../../packages/agent/src/model-config.ts)。

方案者须补齐界面显示的凭据来源、替换与清除所作用的来源，以及删除后仍有内联或环境来源时的生效状态和下一动作；核对后台返回类型、桌面表单与 TUI 的含义一致。保留无关高级配置和脱敏占位符的要求仍成立，不能靠静默删除所有配置秘密修正展示。此项处理方案须复审，登记意见不等于问题已解决。

处理方案：步骤 1–3/5/6 已区分配置位置、所选来源操作与实际连接验证，补齐后端脱敏元数据和 TUI 在线/离线消费、设置选择器及离线入口；不改 SDK 解析顺序，不为列来源执行动态凭据解析。独立方案复审已通过，P2 方案阻断解除；本轮实现与独立复核证据见下文。

## 进展与交接

- 2026-10-21 拥有者要求重写 Code 模型管理页布局，原页面层级与动作排列未获产品接受。本轮重排总览与完整提供方弹窗、认证和模型高级字段的操作入口，沿用既有状态与后台契约；方案经独立上下文 `/root/desktop_test_audit` 复核无阻断。旧截图和界面布局审查不覆盖本轮改版，后端及 TUI 证据继续有效，拥有者追加确认：默认／摘要总览直接选、选择框缩短并右对齐；添加／修改提供方同一完整弹窗，API 类型选择框，左下红色删除，叉号直接丢草稿；删除指定说明、保存中和草稿提示；测试直接执行并用模型名旁黄／绿／红点显示结果。最终布局及交互已通过工程与独立复核，见[布局验收](../evidence/02-layout-verification.md)；拥有者随后明确要求结单；原生重开与真实模型未由 agent 执行的记录保留。

- 2026-10-21 拥有者明确「方案已通过」，目标与产品取舍已确认；本轮接手核实前置 01 已 resolved，起始检出 `6489df70473b32efa6e839e83c1353fc15b59dcb`，工作区干净。按重流程实施，独立工作副本完成后端、TUI 与测试后顺序汇总。
- 已交付：Code 模型页提供方／模型管理、完整高级字段与按位置秘密操作、存储 OAuth 说明、默认／Effort 与摘要模型、显式连接测试及共享修订／未知结果保护；后台纯脱敏来源与真实成员／档位元数据，TUI 在线／离线入口和设置选择器同源，不自动认证求值。事件刷新会话／新聊天目录与后台默认 Effort，旧分页和旧测试结果失效。
- 工程验收通过：静态检查、定向回归、两壳构建与签名检查、正式 renderer 的合成浏览器交互均完成；[证据](../evidence/02-verification.md)区分检查对象与未验证项。实现审查上下文 `/root/desktop_test_audit` 与 `/root/tui_consumer` 覆盖彼此未编写的部分，无未解决阻断；作者测试不替代独立审查。
- 关闭依据：2026-10-21 拥有者在最终布局与字号调整交付后明确要求「转 resolved 并提交」，据此关闭并提交当前分支。真实 Electron／MyGo 配置后退出重开、TUI／会话菜单一致性和真实模型测试未由 agent 执行，仍记未验证，不补记为通过；没有修改日常真实配置，不推送远端。
- 03 的共享 `ops.ts`／IPC 接入继续以实际代码为基点，本单没有实现 MCP、Skills 或 Personal 管理。

## 验收与证据

工程结果与独立复核已通过，当前布局、弹窗和直接测试见[布局验收](../evidence/02-layout-verification.md)，原后台／TUI 命令、负例与外部恢复条件见[验收记录](../evidence/02-verification.md)；下列验收要求及证据保留，真实双壳重开与真实模型未由 agent 执行；当前状态以拥有者明确结单指示为准。

- 新增 `test/desktop-settings-models.test.ts`：真实本机控制面增改读回、跨客户端 revision 冲突、忙拒绝、引用保护、丢答后核实、脱敏与目录事件刷新；使用隔离配置和模拟 provider，禁止真实模型默认联网。
- 补凭据来源回归：仅目录 apiKey、存储与目录 key 并存、存储与已知 provider 环境来源并存；删除选定来源后用合成凭据离线核对实际解析、界面状态及重开结果，其他来源字节与进程环境不变，不能误报「已无凭据」。目录环境模板缺失、目录凭据命令、OAuth 条目和无法核实的 SDK snapshot 在列表只显示已配置位置/未验证；分别打开 TUI 离线入口、在线/离线默认与摘要选择器、Desktop 设置列表，读取期间新增命令执行与 OAuth 刷新计数为零、无网络请求，不把后台初始化的历史计数算入本次读取；不能靠 mock 掉整个列表漏测 list_models/probeModelConfig 的旧求值入口。不把 auth.json 的任意 !字符串推定为命令。provider/model/modelOverrides 的单个 header 或 apiKey 清除只改变选定字段，其他高级字段与秘密占位符保留，header 不误报认证成功。响应、事件、错误及终端输出无 key/token/header 值或命令正文；落到 `test/31-model-config.test.ts`、`test/33-config-tui.test.ts` 及桌面模型用例，验证在线/离线文案和状态一致、最后凭据不可移除时原配置回滚。执行/composer 的认证校验回归仍须通过。
- 定向回归：`npx tsx --test test/31-model-config.test.ts test/33-config-tui.test.ts test/38-desktop-main.test.ts test/desktop-composer.test.ts test/desktop-session-settings.test.ts test/desktop-settings-models.test.ts`；`npm run check:static`。
- 产品验收：拥有者明确指示结单。双壳配置后退出重开、TUI/会话菜单一致性及真实模型测试未由 agent 执行，证据仍记未验证，不将结单指示当成真实测试通过。
- P2 修订经独立方案复审通过，见[记录](../review.md)；初审不覆盖的凭据契约以本轮复审为准，实现审查已通过，产品结单依据拥有者指示，外部实测缺口保持原记录。

## Comments

2026-10-21：后台已有管理操作，主要工作为类型、桌面接线与表单。

2026-10-21 复审：发现清除存储密钥后回退内联密钥的反例，已写入正文的 P2、修订范围与验收要求；未修改产品代码，未解除阻断。

2026-10-21 方案返修：按配置位置定义状态和操作范围，增加安全的脱敏来源读取、TUI 在线/离线同步及不解析动态凭据的验收，提交独立方案复审。

2026-10-21 返修复审补充：审查者沿真实入口发现在线设置选择器的 list_models 和 TUI 离线自动 probe 仍会求值认证；已将这两处消费路径纳入步骤 2/6 和零新增求值验收，保留执行/composer 的原认证验证。

2026-10-21 返修复审通过：独立上下文 /root/revision_review 亲验脱敏/占位、SDK 元数据与真实目录的 checkAuth 调用，核对补齐的消费路径，解除 P2 方案阻断；产品实现与验收未执行。

2026-10-21 方案批准：依据拥有者「方案已通过」解除产品评阅阻塞，状态改为 ready-for-agent；保留前置依赖和待实现/待验收状态，未开始产品实施。

2026-10-21 实施交付：后端、Desktop、TUI 来源语义与纯读取落地；修复独立审查发现的动态凭据错误反射、JSON 特殊字段、秘密空输入、默认／摘要读回、迟到结果、默认 Effort、TUI header 明文及修订偷换问题。定向、静态、构建、签名和合成界面验证通过，独立实现审查无剩余阻断；状态转 ready-for-human，保留真实双壳重开和指定费用模型测试的验收缺口。

2026-10-21 布局返工交付：默认／摘要总览直接选、完整提供方弹窗、右对齐紧凑选择框、API 类型选择框、左下红色删除与叉号放弃草稿落地；指定提示及测试确认窗移除，测试以模型名旁黄／绿／红点和可访问详情呈现。定向、静态、双壳构建／签名与合成浏览器验证通过，独立审查无剩余阻断，状态恢复 ready-for-human，真实重开和真实模型仍未验证。

2026-10-21 排版微调：按拥有者截图将总览分组标题略放大加粗、设置项略放大用常规字重，增加分组间距，并缩小「添加提供方」字号；布局 7 项、静态与浏览器实际样式／窄窗检查通过，证据见布局验收的「字号与间距微调」。

2026-10-21 拥有者结单：依据「转 resolved 并提交」将本单改为 resolved，提交本轮 Code 模型管理实现、布局调整、测试、文档与验收证据；未执行的真实模型和原生重开不记为通过，未要求推送。
