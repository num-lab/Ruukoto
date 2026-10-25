# 配置更新实施与验收

基点为 e84ae1c9c861fa9d49fbfbc0aab7c616ccb37f67；本次按拥有者授权提交实现与证据，未推送或部署。以下记录分清本机替身、真实本地接口与外部环境；未完成项保留，不据 implemented 笔记认定工单已验收。

## 当前范围

已汇总 Code 模型目录差异和 rg 发现、MCP 凭据收窄、个人设置 v2 操作与配置版本、在线/离线共用保存、格式迁移、remote 及共享桌面页面、模型/Skills/MCP/搜索运行选择、IM 平台切换、命令/服务版本迁移。独立审查还覆盖共享文件保存链、MCP 并发发布、旧 scope 删除、分页与跨入口原键查询、实际控制入口冷启动文件异常隔离。

服务宿主基线的只读能力、撤回运行参数与初次启用后的再次保存均已修复，最终独立5项回归通过。真实 Electron 发现的目标异常全局禁止导航也已修复；文件问题和已读 v2 未知回执只锁对应目标，原操作键保留，其他配置页可继续管理。未读回的传输丢答仍先核实原关联，不自动丢弃草稿。

## 已执行检查

本机为 macOS arm64、Node 24.15.0。早期 1024 项个人测试广跑有 42 个失败、2 个取消和2个 Linux 平台跳过，不记为通过：暴露了过期全局阻塞断言、旧 CLI 菜单夹具、空 IM 清理延迟释放锁、摘要误作完整配置和资源竞争。修复后按相关文件有界并行复测，最终结果按下表续记。

| 内容 | 实际结果与边界 |
| --- | --- |
| MCP/Skills/搜索/CLI/持久恢复/桌面设置组合 | 124/124 通过；本机替身模型与真实文件/SQLite，不证明外部平台 |
| 设置操作、scope 与回执分页、桌面页及 MCP 发布 | 67/67 通过；含第34笔回执和 A 等待、B 生效的分离 |
| 资源竞争失败项定向复测 | 120/120 通过；命令停止、Skills 包完整性、问题、定时、通用工具与工作恢复 |
| 共享存储失败锁释放 | 原 durable/work 失败负例4/4通过，服务存储失败4/4通过；不延长测试等待来掩盖锁时序 |
| 实际控制入口与六目标文件损坏冷启 | 通过；同 socket 四类 CLI 查看、状态实际模型读回、零模型调用，恢复原字节后解封 |
| HTTPS 双后台隔离及客户端组合 | 12/12 通过；实际 Code 控制 socket 与回环 TLS/WSS 个人夹具，非真实桌面壳 |
| remote 跨入口查询与旧维护 | 8/8 通过；本机创建的设置操作可经 remote 按原键查询，接纳关联不充当保存权威 |
| IM admission 与存储失败 | 平台作者132项通过；独立审查22项、关闭4/4与QQ候选失败1/1、移除保护的失败负例另记，不含真实 TG/QQ |
| 命令/服务与设置最终组合 | 主区238/238通过；最后服务参数/只读/基线保护增量另由独立上下文5/5复核，不混成同一次运行 |
| Code目录、rg及CLI配置 | 主区79项中77通过、2个Linux平台跳过、0失败；实际Linux结果另列 |
| 托管Skills集成 | 改用共同v2入口维护选择后29/29通过；直接改store会被正确识别为外部改写，未放宽fileIssues保护 |
| 页面及导航容器 | 48/48通过；独立复测两个目标级异常跨页反例2/2通过，真实Electron另列 |
| `npm run check:static` | lint、全工作区类型、笔记和文档门禁通过；随后UI导航修复补根tsc、相关ESLint、48项回归及双壳重建，文档再检通过 |
| 构建 | `npm run build:worker`、`npm run desktop:build`、`npm run desktop:mygo:build` 通过；macOS arm64 ad-hoc 签名，不是公证或实机交互 |
| MyGo Go 检查 | `cd apps/desktop/mygo && go test -race ./...` 通过 |

## 真实模型

拥有者指定模型目录 `/Users/eitrous/.ruukoto-code/agent/models.json`。执行 `RUN_MODEL_CHECK=1 RUN_PERSONAL_MODELS_FILE=/Users/eitrous/.ruukoto-code/agent/models.json RUN_PERSONAL_MODEL=magpie/auto/deepseek-v4.1-flash npx tsx verification/smoke/smoke-personal-configuration.mts`，最终通过。

脚本使用临时档案、临时环境变量和临时技能库，核实同 PID 在线更新、在途请求的旧 Skills 正文、后续请求的新正文、不可复用 provider 版本及冷启动后保持新选择，共3次拥有者输入；模型可能产生多轮工具续接。请求记录断言不含认证值，清理临时档案并恢复环境；未操作日常 Agent 或 IM。

## 真实环境与待验

Linux 在 `ssh tx` 的隔离副本执行，Node 24.21.0，与 CI 固定24.15.0有差异。迁移受控用例15/15、[真实后台 scope](linux-background.log) 1/1及[最终宿主基线组](linux-final.log)14/14通过；独立审查者亲自读取远端日志，并验证最终组10个相关源/测试文件与主区逐字节相同。最终源包 SHA-256 为 `ff9fe80eddf8c315166045a5b40ac642172396abd88a549c234837fd5aacb225`，最终组日志为 `de504deb726326992e57a17c7647db584cda428338bc4efdceb04f1e2b79c724`。只把真实后台用例计作内核 scope 实证，不把受控 helper 桩当生产 sudoers 部署。

Electron 使用真实 shell/Host/bridge/renderer、临时 HTTPS/WSS 远端和测试专用凭据存储，最终10/10交互通过、页面错误0，覆盖生效失败、坏凭据服务停用和目标异常跨页修复；[逐步截图、隔离与来源指纹](electron/electron-gui-review.md)已入库，主代理核对截图和来源/构建/脚本哈希。入库文本仅规范末尾换行，本目录制品哈希重算，原始证据包哈希保留。这不证明真实 Keychain 或实际 PA 服务部署。MyGo 已有开发凭据槽，无法用临时 userData 隔离 Keychain，未读取或改写其内容；真实保存/草稿/断线/等待交互保留待验，需要独立系统测试账号或可隔离凭据环境。Telegram/QQ 实机验收由拥有者明确暂缓，对应替身测试不冒充外部通过。

## 要求对应

| 要求 | 当前证据与结论 |
| --- | --- |
| A1 | 实际控制socket四类CLI查看、同socket/同PID、零模型调用通过 |
| A2 | 在线、开发、无systemd、缺原key与离线保存回归通过；离线不启动，未把shell环境当后台连接测试 |
| A3 | 主/子/定时/审查/图片选择的定向回归及真实模型旧/新Skills、独立provider和冷恢复通过 |
| A4 | 坏凭据停用/删除与启用拒绝、服务独立发布、原批准/未知调用及电脑边界回归通过；不冒充真实MCP/电脑部署 |
| A5 | 连续label、离线中间链、实质变化后改回仍失效通过 |
| A6 | Code运行/排队/待确认时展示变更和真正新增ID、SDK内置覆盖与回滚通过 |
| A7 | 独立搜索无资料目录、在途证据、额度、停用和旧计划范围通过 |
| A8 | 平台接纳/发送/配对交错及失败事实通过独立审查；真实TG/QQ按拥有者要求暂缓 |
| A9 | 原历史/相关占用/同机新配置、host基线与撤回通过；隔离Linux最终14项及真实后台scope通过，未部署生产helper |
| A10 | 各持久阶段故障、同键异参/并发修订、A等待/B发布、共享StorageFailed及恢复通过 |
| A11 | 无根初始化、迁移标记恢复、坏库/未知格式拒绝、旧v1客户端与维护解释回归通过，旧entries保留 |
| A12 | 同进程rg再发现、Electron隔离交互及双壳构建通过；MyGo实机与真实Keychain仍待验，整体未记通过 |

## 审查记录

目录/凭据/检索见[独立目录审查](catalog-review.md)，设置/模型/remote/桌面见[设置审查](settings-review.md)，MCP 并发发布见[发布审查](mcp-publication-review.md)，IM 反向失败实验见[阶段记录](im-review.md)，最终 IM/命令/服务与Linux来源核验见[执行审查](im-execution-review.md)，文档一致性及最终增量指纹见[文档审查](docs-review.md)。旧指纹不扩展到后续变动；host元数据、只读与撤回的最后增量由执行审查补充，导航最后增量由Electron及独立2项复测补充。
