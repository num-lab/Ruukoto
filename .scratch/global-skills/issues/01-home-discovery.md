# 两产品统一从宿主用户目录发现技能

Status: resolved

## 目标与边界

拥有者在本聊天要求统一从 `$HOME/.agents/skills/` 发现技能，删除 PA 选择技能库与导入技能包功能；随后明确 Code 也删除导入，全部通过目录维护。两端均以运行后台账户的 HOME 为来源，PA 不读取桌面账户 HOME。新发现只含固定目录，旧档案 skills.json、实例 skills/ 与托管包不进入新目录。

保留技能目录、按需正文/引用、显式调用、快照与历史核实，以及桌面/CLI 的只读列表、检索、分页与诊断。移除两端新的配置来源、导入、启停和删除技能操作。不移动、复制或删除用户旧文件、托管包及历史记录，不改模型能力与审批，不提交或部署。

## 方案

1. 共享 skills.ts 以 os.homedir() 解析固定目录；扫描器仍支持显式来源用于历史和离线解析，生产发现不接受可变根。提供现有只读列表/详情响应，修订反映当前目录内容；删除 managed-skills 新管理代码，只保留历史需要的验证。
2. Coding Driver 与 Runtime 使用固定目录；新任务刷新，原任务恢复保留原钉版。Control 删除技能写协议，桌面 Electron/MyGo/renderer 删除导入桥及写状态。
3. PA 新快照显式记录固定来源，保留旧快照字段与哈希核实；删除 skills.json 读写配置和导入/目录选择/技能状态管理。旧配置目标、版本链、维护回执继续可读，但不再作为当前请求发现与暂停条件。不同技能来源的旧定时范围明确拒绝，不静默扩大。
4. CLI 变为查看技能；PA 与 Code 桌面只读。更新测试以临时 HOME 隔离，覆盖固定目录、旧来源不生效、刷新/钉版、已退役操作拒绝与旧历史兼容。
5. 同步使用手册、模块文档、README/开发与检查入口中的受影响说明及决策笔记，执行静态门禁、最窄受影响用例和独立实现审查。

## 进展与交接

- 当前角色与阶段：实施与独立审查完成，结果已汇总至主检出；未提交或部署。
- 下一角色与动作：拥有者可审阅当前未提交 diff；真实模型、生产服务与人工双壳体验另行验收。
- 当前内容：基点 99305f57c176d11284bb4bb333751f302d3667b2；当前 `git diff` 与未跟踪的本工单、决策笔记、global-skills 用例及 skill-home 夹具构成本次交付。
- 阻塞与恢复条件：无；已有用户授权覆盖两端导入删除与固定目录发现。

## 验收与证据

- 固定来源：临时 HOME 中有效包可见；旧实例目录、PA 配置库和托管包不进入新的发现结果；缺目录为空。
- 历史：旧正文与显式展开不变，恢复可核实；旧技能配置和维护回执仍可查询，当前请求不被退役来源暂停。
- 接口：目录选择、预览、导入、启停、删除及技能库配置写入在生产入口拒绝，不创建新包或修改旧文件。
- 客户端：Skills 页无选择/导入/保存操作，读取、分页和诊断正常；CLI 只有查看。
- 静态检查：`npm run check:static` 通过（Node 24.15.0，macOS）；包含全 workspace 类型、lint、笔记与文档检查。门禁曾发现基点已有 personal-mcp.ts 的 text discriminator 被扩大为 string，独立副本复现后用 `as const` 收窄，运行字节不变。
- 后端定向检查：`npx tsx --test test/global-skills.test.ts test/56-skills.test.ts test/managed-skills-reference.test.ts test/personal-skills.test.ts test/personal-managed-skills.test.ts test/personal-settings.test.ts test/personal-settings-blockers.test.ts test/personal-cli-settings-updates.test.ts test/personal-reports.test.ts test/66-control-seam.test.ts`：121 项通过；历史修复后另跑 personal-managed-skills、personal-remote-maintenance 与 personal-settings-operations，40 项通过。
- 调用方检查：111-workflow-capabilities、113-workflow-source-capabilities、subagent-source-capabilities 与 125-agent-wait-resource 四文件共 52 项通过；`npx tsx --test --test-name-pattern='显式调用提交' test/14-tui-app.test.ts`：1 项通过。覆盖角色及来源工具限制、同轮恢复和新任务刷新。
- PA 集成：personal-durable、personal-cli、personal-settings-operations、personal-remote-maintenance、personal-scheduler-integration 与 personal-mcp-controls 六文件：108 项通过，1 项 Linux sudo 服务核实用例在 macOS 按原条件跳过；不记该平台用例通过。
- 桌面：desktop-settings-skills、desktop-personal-settings-pages、desktop-personal-settings 与 desktop-mygo 共 59 项通过。`npm run desktop:build` 与 `npm run desktop:mygo:build` 均完成；桌面实施者在隔离副本另跑 MyGo race 测试通过。真实模型 smoke 更新为临时 HOME 固定目录，但未执行联网模型请求或生产切换。
- 工程验收：通过；独立实现审查及历史修复复审无剩余阻断。产品验收：无新增主观设计取舍，SSR/状态用例核实只读入口，人工双壳体验未执行且不据此声称体验通过。

## Comments

2026-10-28：用户确认 Code 同时删除导入，全部通过目录维护。

2026-10-28：personal_skills 在独立上下文核对原始请求、工单与源码，方案审查通过。补充验收 Driver 旧参考派生新任务刷新、PA 档案锁不再扫描退役托管区及旧导入维护回执仍可读。

2026-10-28：review_skills_final 独立审查当前 diff 并亲验 64 项用例，发现 v1 restore 比较新 HOME 修订导致 pending 不解除、v2 查询将退役来源错误发布两项 P2。实施者修复并新增两种 v1 操作与两个 v2 目标乘两种状态的回归；审查者再亲验 personal-remote-maintenance 与 personal-managed-skills 共 15 项，通过且无剩余阻断。先前审查的其余部分未因这两处修复失效。
