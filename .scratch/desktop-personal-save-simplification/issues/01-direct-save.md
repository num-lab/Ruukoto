# PA 桌面直接保存设置

Status: ready-for-human

## 目标与边界

拥有者在本聊天明确要求彻底删除“查看保存影响”，保存前不再确认原档案，并简化修改远端配置时的交互限制。正常流程为编辑后直接保存；模型、MCP 服务、电脑配置及其启停、删除、迁移、撤回共用直接提交。桌面草稿不再携带原档案与旧修订作为保存前提，宿主按当前认证连接补齐内部协议字段。刷新保留草稿，不制造必须放弃草稿才能保存的冲突。异常恢复、等待结果与诊断只在需要时出现。

认证、远程连接绑定、服务端单写入者、配置版本链及未知写入的原键核实继续由程序管理。停止沙箱及结束未知业务调用的独立确认、Skills 只读来源、Code 设置与连接设置不在本次行为调整范围。

## 方案

删除 PA 页面通用确认状态与对话框，直接保存并返回实际结果；保存并继续复用 save。宿主从当前管理视图补齐 profile 与最新修订，不使用编辑前的标识作为保存限制；明确未发送与拒绝时清除本机待核实关联。精简正常页面的档案和维护信息，处理 PA 保存等待时的导航与原结果恢复，保留其他设置页的草稿保护。

影响 apps/desktop 的 personal-settings-state、personal-settings-pages、personal-settings-controller 与共用设置容器，更新对应测试、docs/modules/desktop.md 与决策笔记。独立审查者负责核实提交生命周期、未知结果、导航及调用方。

## 进展与交接

- 当前角色与阶段：实施与独立工程审查完成；直接保存、当前修订、原键自动核实和 PA 离页提交保留已交付工作区。
- 下一角色与动作：拥有者在真实桌面与 PA 环境验收保存、切页和重连体验；拥有者已授权本批提交，部署与发布未执行。
- 当前内容：基点 ce2d6a8bab5e3c9cd03c8bfd29a21d3752a04804，开始时工作区干净；实施审查时已跟踪差异的 SHA-256 为 ed1958ac08e2276f9bbcba6750f8f87a37a617176d3c5d5183e54a36abe48b45；新增文件为本工单与 .agents/notes/implemented/simplification/2026-10-28-desktop-personal-direct-save.md，均在审查范围。
- 阻塞与恢复条件：无待拥有者决定的事项。

## 验收与证据

工程验收通过：一次保存产生一次写请求，无通用确认；正文不携带编辑前档案或修订，程序生成原操作 ID；宿主使用当前认证连接和最新修订；刷新保留草稿且可保存；未发送清除原关联，未知结果不重发；PA 导航不会丢失尚未确定的提交，其他页保护不变。自动与手动核实共用收敛逻辑，保留打开的服务编辑器、电脑恢复图片及独立确认；读取失败停止自动监督。

作者执行 npx tsx --test --test-concurrency=1 test/desktop-personal-settings-pages.test.ts test/desktop-personal-settings.test.ts test/desktop-settings.test.ts test/38-desktop-main.test.ts test/38-desktop-build.test.ts test/desktop-personal-native.test.ts test/desktop-models-layout.test.ts test/desktop-settings-mcp.test.ts，168 项全部通过，无跳过；日志 /tmp/ruukoto-pa-save-final-tests.log。npm run check:static 与 npm run desktop:build 通过，日志分别为 /tmp/ruukoto-pa-save-static.log 与 /tmp/ruukoto-pa-save-build.log；签名校验 codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app 通过，git diff --check 通过。

产品验收待验收：真实桌面的保存、切页、重连体验；工程测试与构建不替代真实 PA 环境验收。

方案审查：2026-10-28 独立代理 simplification_plan_audit 审查通过，要求保留 PA 提交生命周期、按原键推进等待、明确未发送时解锁，均已纳入实现。

实现审查：2026-10-28 同一独立代理对最终 diff 审查通过，无未解决阻断。亲验 20 项定向回归以及最终截图保留用例；用现有 HTTPS 夹具经真实 DesktopHost.request → PersonalSettingsController.apply → POST /maintenance 核实 ID 完整透传、缺失与非法 ID 拒绝、单次保存。上述 HTTPS 为夹具验证，未计为真实 PA 验收。

## Comments

2026-10-28：拥有者授权本次行为简化，无需另行请求相同范围的确认。
