# Pi MCP 集成与交接证据

本次接手基于 `85d007b9` 的未提交实现，主工作区单写入者整合，三个独立上下文只读审查 Code／共享 SDK、Personal、客户端。实现覆盖 P1–P5；原技术门槛见 [P0](2026-10-26-p0.md)。验收记录形成时尚未提交、推送、部署或发布，真实档案未切换。

## 最终检查

macOS 使用 Node `24.15.0`；Linux 使用 `ssh tx` 的隔离目录 `/tmp/ruukoto-pi-mcp.r0wcnE/source`、Node `24.21.0`，未修改生产档案或系统设置。检查对象由 [源码摘要](integration-2026-10-27/source-manifest.json)固定；日志归 [本次证据目录](integration-2026-10-27/)。下列集合有交集，不相加成独立用例总数。

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 根构建、两份锁与依赖解析 | 通过；Pi 系列固定 `1.3.0`，没有旧客户端直接依赖 | [构建](integration-2026-10-27/logs/build.log)、[依赖树](integration-2026-10-27/logs/dependencies.log) |
| `npm run check:static`，文档最终同步后另跑 `check:docs` | lint、各包类型、笔记和文档门禁通过 | [静态](integration-2026-10-27/logs/static.log)、[文档](integration-2026-10-27/logs/docs.log) |
| Code／共享 SDK 最终定向集合 | 303/303，0 skip | [完整输出](integration-2026-10-27/logs/code-final.log) |
| 官方 direct／deferred 曝光同步后的复核 | 90/90，0 skip；覆盖 24/25-MCP、搜索、工作流与 SubAgent 来源及等待资源链 | [曝光复核](integration-2026-10-27/logs/exposure-final.log) |
| Personal MCP／配置／Cua／工具最终集合 | 136/136，0 skip | [完整输出](integration-2026-10-27/logs/personal-final.log) |
| 取消、调度来源与收尾 | 57/57；后补停止失败重建单例也通过 | [生命周期](integration-2026-10-27/logs/lifecycle-and-cancel.log)、Code 最终集合 |
| Foundation | 7 通过，1 真实模型用例按离线开关跳过 | [输出](integration-2026-10-27/logs/foundation.log) |
| Code Cua 原生产品链 | 3/3，包含无关会话销毁后仍保持原连接 | [输出](integration-2026-10-27/logs/cua-session-ownership.log) |
| TUI／请求快照／手动压缩 | TUI 三个受影响用例、prompt 六例、手动压缩十四例及真实 PTY compact 单例通过 | [TUI](integration-2026-10-27/logs/final-tui-14.log)、[prompt](integration-2026-10-27/logs/final-prompt-20.log)；独立复审记录见下文 |
| Electron 与 MyGo | 两壳构建、ad-hoc 签名通过 | [Electron](integration-2026-10-27/logs/electron-build.log)、[MyGo](integration-2026-10-27/logs/mygo-build.log) |
| Linux MCP／Cua／原生集合 | 首轮 202 pass、1 fail、2 平台 skip；修复复核 104/104、旧联锁回归 1/1、最后生命周期 2/2 | [首轮](integration-2026-10-27/linux/logs/mcp-native-tests.log)、[复核](integration-2026-10-27/linux/logs/recheck-tests.log)、[联锁](integration-2026-10-27/linux/logs/personal-tools-recheck.log)、[生命周期](integration-2026-10-27/linux/logs/final-lifecycle-tests.log) |
| Linux 真实 scope 与清理 | 个人后台 1/1、launcher 三项探针、Cua 管理 scope 通过；原 scope／cgroup／fixture PID 已消失 | [后台](integration-2026-10-27/linux/logs/personal-background-real-linux.log)、[launcher](integration-2026-10-27/linux/logs/linux-scope-probe.log)、[Cua](integration-2026-10-27/linux/logs/native-cua-scope-probe.recheck.log)、[清理](integration-2026-10-27/linux/logs/native-cleanup-check.recheck.json) |

Linux 最终核对的 18 项源码摘要与主工作区一致，见 [交付对照](integration-2026-10-27/linux/source-current-comparison.delivery.json)。最后曝光修订另跑四种工作流和固定角色共 [5/5](integration-2026-10-27/linux/logs/fixed-role-exposure-tests.log)；随后仅增加 TypeScript readonly 元组注解，无运行时变化。Cua 截图服务为 fixture，真实部分是原生执行身份、scope、停止与清理，不代表实际 Cua 桌面截图或模型体验。Linux 版本高于仓库最低 Node；macOS 已在最低版本验证。

## 集成时发现并修复

- 官方结果 schema 已重定位本地 `$ref`，抽出子 schema 会误拒合法结果；现保留完整外壳校验，并覆盖合法引用与非法结果。
- 重复 JSON-RPC ID 可在首次持久化等待期间提前交付答复；现逐调用串行保存，成功后才发布证据，失败仍未知。取消后的迟到保存不会覆盖同连接新调用。
- Personal Cua 恢复曾因描述变化自锁；现只比较参数 schema，描述变化允许恢复，参数变化仍拒绝。
- SDK 1.3 的系统条目使手动压缩计数与装配不一致；原 JSONL 保留，压缩只计对话。请求快照 v1 继续分别保存系统提示、工具与对话。
- 宿主工具声明过早删去停用的 Web Search，绕过既有发送阻断语义；现保留原宿主声明，由发送门拒绝，同时仅更新 MCP 的当前声明。
- 异步 SDK 关闭被取消与队列同时触发时访问已清空句柄；现共享一次关闭，新建等待完成，停止失败保留旧 SDK 与重建要求。
- 每个 Driver 关闭时曾调用共享 Cua 的全局停止；现按会话收尾，全实例退出保留全局停止。真实原生反例由 `active → idle` 转为保持 `active`。
- 补齐官方工具名、来源 Driver 预检夹具、凭据撤销确定时序、Home/End 绑定与硬件光标断言；删除无消费者的普通 URL 联锁助手。
- 固定工具身份曾只修改宿主曝光，官方系统提示仍引导未开放的 `tool_search`；现向官方同步 direct／deferred 并纳入配置选择，重采 SubAgent／具名工作流后不再出现该引导。

## 验收矩阵

| 要求 | 工程证据与边界 |
| --- | --- |
| A1 | 正式官方 factory／客户端路径、最终依赖树及源码检索；无旧客户端、`planMcpTaskTools`、`search_tools` 或原流恢复执行器回退 |
| A2 | 25-MCP、63/64 审批与账本、transport 发送前持久／取消／重复 ID 反例；真实宿主事务覆盖，不以 P0 模拟批准替代 |
| A3 | 搜索、44/58/62、113 工作流来源与 SubAgent 来源用例；实际官方注册表、动态服务变更和固定要求在模型前核实 |
| A4 | Code 与 Personal 丢答、冷恢复、远端／本地错误来源及迟到持久测试；未知写不重放 |
| A5 | Personal 工作、委派、报告、调度消费者及最终 tools 来源回归；原来源暂停，人工收尾不伪造远端结束，独立来源同 URL 可用 |
| A6 | Personal 旧记录、无网络退役任务、保存／生效崩溃窗口和旧 Cua 格式迁入；旧 Code JSONL 与图片证据见 [旧档案](legacy-code/result.json) |
| A7 | v4 旧默认 unknown、read／write 分类、换行规范化、显式重绑、缺失凭据禁用服务迁入；配置与控制用例通过 |
| A8 | 纯图、混图、错误附图、长结果、坏图、重开和实际 mock provider 输入；原图／原完整结果归属保留 |
| A9 | Code 原生监督器产品链、Personal Cua、Linux 真实 scope、异会话关闭不误停；实际双端 Cua 桌面仍待外验 |
| A10 | 独立客户端审查覆盖 CLI/TUI、Desktop、remote、控制与丢答核实，246 pass、1 Linux 平台 skip；退役操作不再发布 |

## 独立实现审查

审查者分别直接读取规格、实际源码和检查输出，不以作者自检替代。Code 审查者发现 schema、持久交付、并发关闭、失败重建标记与 Cua 归属缺口；Personal 审查者发现恢复定义比较与旧联锁测试；客户端审查者核对退役入口、协议 42、文档事实和基点失败。上述问题均返主写入者修复。

最终 Code 复审亲跑 transport／observer 31 例、原缺陷反例、真实 Runtime 并发关闭、停止失败保留与重试，以及 macOS Cua 原生产品链；曝光修订另复核 12 条，客户端独立重采固定身份请求，均无剩余阻断。Personal 复审与 Linux 最后 18 项源码摘要核对完成；客户端复审亲跑 TUI／prompt／104 手动压缩与 15 PTY compact，并对全量失败做旧版对照。审查只支持工程行为，外部产品验收不据此通过。

## 全量结果与既有失败

最初 `npm test` 的 macOS 独占批次 71/71，常规批次 3553 例为 3505 pass、25 fail、23 skip，见 [原始输出](integration-2026-10-27/logs/initial-full-app.log)。其中迁移引入或随迁移失效的行为／夹具已用最终定向集合复核；未重复跑一遍已知仍会失败的全量，也不把该次全量写成通过。Foundation 后续单独完成。

以下八项失败在 `85d007b9`／Pi 0.85.1 对照复现，保留原安全规则，不为本工单扩修产品或放宽断言：

| 用例 | 既有原因与对照 |
| --- | --- |
| 19 demo 全事件 | 缺 Code schedule 与 Web Search 事件；[19/43 对照](integration-2026-10-27/baseline/baseline-19-43.log) |
| 43 GUI 定稿样式 | 冻结 CSS 前缀缺行；同上 |
| 45 普通子代理 MCP | 旧输入头匹配不到实际子请求；[对照](integration-2026-10-27/baseline/baseline-45-mcp.log) |
| 65 操作手册命令表 | 文档重构后解析得到空表；[对照](integration-2026-10-27/baseline/baseline-65-context-82.log) |
| desktop-context 双目标 | 旧 Personal 通用连接按现行安全规则拒绝；同上 |
| desktop-settings-models 忙提供方 | 元数据保存返回值与旧断言不符；[对照](integration-2026-10-27/baseline/baseline-desktop-models-busy.log) |
| personal-background-processes 认证 socket | 测试绕过已记录配置历史后才写配置文件；[对照](integration-2026-10-27/linux/personal-baseline/ruukoto-pi-mcp-personal-late-head-baseline.log) |
| personal-services 取消检查 | helper 在创建 claim 与完整写入之间被取消，旧用例过早以 calls.log 为完成前提；[原基点确定性反例](integration-2026-10-27/linux/personal-baseline/ruukoto-pi-mcp-personal-claim-race-baseline.log)、[等待 claim 的对照](integration-2026-10-27/linux/personal-baseline/ruukoto-pi-mcp-personal-claim-race-fixed.log) |

## 模型可见文本

以下数字来自完整实际 mock provider 请求与宿主快照，使用共用估算器，单位为估算 token。Personal 没有 Code selection record，数字由相同估算器对实际请求计算。完整文本与复跑脚本归 [快照目录](integration-2026-10-27/text-snapshots/)；只保存测试请求正文，不含鉴权 headers，常见秘密模式扫描零命中。

| 请求 | toolSchemas 前→后 | systemPrompt 前→后 |
| --- | ---: | ---: |
| Code 正式工具，普通首轮 | 13364→13266 | 1503→1568 |
| Code 搜索命中后 | 13481→13307 | 1503→1568 |
| Code Plan | 7688→7592 | 1503→1568 |
| Personal 主会话 | 10437→10518 | 563→563 |

另补采三种身份，工具路径均由实际 provider 请求验证。Code 普通 SubAgent 与具名工作流从首轮直接调用 MCP，不出现缺失的搜索工具指引；Personal 子会话完成 `mcp_tools → mcp_call → read_mcp_result`，每份 provider payload 与持久请求记录一致。

| 当前身份 | toolSchemas | systemPrompt |
| --- | ---: | ---: |
| Code 普通 SubAgent | 6344 | 890 |
| Code 具名 MCP 工作流步骤 | 54 | 1074 |
| Personal 子会话 | 2487 | 353 |

## 产品验收与恢复条件

工程实现与受影响独立审查已完成，工单进入 `ready-for-human`；整体不记 `resolved`。拥有者还需在隔离档案完成双壳 MCP 配置／凭据轮换、未知调用人工收尾、原 IM 送达及双端实际 Cua 停止／新图／接受的操作验收。普通 HTTPS 写工具须由拥有者提供明确的隔离目标；真实模型须显式提供模型配置与调用许可。已有构建、mock provider、SSR 和原生 scope 证据不能代替这些项目。

恢复时沿本工单及源码摘要继续，先补所需外部环境，不切换真实档案或自动重放原操作。整仓门禁仍有上述既有失败，提交、部署与发布仍需沿拥有者授权另行处理。
