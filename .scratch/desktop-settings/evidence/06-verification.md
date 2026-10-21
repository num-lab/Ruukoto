# Personal 配置管理入口：实施与验收

## 对象与范围

实施基点 `eca383bcbc3fe66548df3eef52c3c8adbf25c291`，开始时工作区干净。06 已批准，前置 04 已 resolved；本单只交付新 Personal 的后台配置协议、停机持锁写入与托管接线，不迁移聊天或旧控制协议。MCP 与机器接口在独立工作副本实施，根工作区单写汇总；独立审查只读。

`ruukoto settings` 通过 stdin/stdout 交换有界版本 1 JSON；在线使用当前认证后台的 `/settings`，离线连查询也持档案锁。身份、修订、未决输入/工作及所有未核实外部占用在同一锁内复核，再复用原保存函数。模型显式测试使用后台实际环境，固定 ping、1 token、无工具、30 秒与脱敏结果；规范输入和实际 payload 先写专用 data entries，写失败零 HTTP，不产生主会话工作或进入后续聊天。

托管根共用顶层私有目录分类，EXCLUSIVE 锁后、读配置/启动前复用内部布局检查；安全暂存可重开，未知节点及不安全类型/权限继续拒绝。个人实际请求合并显式外部库与当前托管清单，旧快照、正文、引用及请求 entry 原样保留。MCP version 1 原样读取，经显式迁入启用逐服务 version 2；新代次与启停保留完整原定义、批准和旧历史，旧程序拒绝新版本。接口、参数与生效规则见[操作手册](../../../docs/usage.md#25-个人-agent-引导与管理)；理由见[设置决定](../../../.agents/notes/implemented/feature/2026-10-21-personal-settings.md)。

## 工程验证

环境为 macOS / Darwin、Node v24.15.0，模型和 MCP 使用本地替身，档案、SQLite、Unix socket、CLI 子进程、文件权限与链接为真实隔离对象；错误 UID 使用受控 lstat 夹具，未冒充实际 chown 验收。

| 检查 | 实际结果 |
| --- | --- |
| `npx tsx --test test/personal-settings.test.ts test/personal-settings-blockers.test.ts test/personal-managed-skills.test.ts test/personal-durable.test.ts test/personal-configuration-controls.test.ts test/personal-cli.test.ts test/personal-skills.test.ts test/personal-mcp-config.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-mcp-controls.test.ts` | 最终组合 172 条，171 通过、0 失败、1 项既有 Linux sudo 用例在 macOS 跳过 |
| `npm run check:static` | 最终代码的 lint、全 workspace/基础验证类型、笔记、链接、源码引用、预算与段落形态均通过 |
| `npm run build`；最终 `npm run build --workspace=ruukoto` | 原生监督器、两类 worker、脚本/WASM 与两产品 tarball 构建通过；外部占用 helper 汇总后重新生成个人包，含两个新设置模块 |
| `npx tsx --test test/personal-entry.test.ts test/71-product-entry.test.ts test/32-dev.test.ts test/99-workspace-boundaries.test.ts test/personal-cli.test.ts` | 82 条，81 通过、0 失败、1 项既有 Linux sudo 用例跳过；覆盖实际入口图、双 Pi、旧档案拒绝、双进程、watch/信号退出及 Code 不受影响 |
| 最终个人 tarball 的实际解包 workspace smoke | 只为依赖解析链接本机已安装 workspace，执行解包后的 bin；确认 JSON、模型单文件保存、离线测试未验证、Python SQLite 持锁冲突、托管导入/停用/重新持锁与权限、新文件入包、未知操作/版本拒绝均通过；没有启动真实服务 |
| `git diff --check`；`npm run change-scope -- --base eca383bcbc3fe66548df3eef52c3c8adbf25c291` | 通过；改动只在个人 app、定向测试、相关文档/决定与本单记录，无新依赖 |

新增机器回归覆盖认证、请求/响应边界、未知操作/版本/字段、错档案和修订、在线禁写、无变化保存仍检查未决、原子文件失败、凭据与端点 query 脱敏、真实模型测试输入/payload 记录失败零 HTTP、工具发现不调用业务工具、有界远端目录、外部库失效诊断及合法外部 skills 子目录链接。超过 128 KiB 的合法 MCP 配置以 34 个原工具证明仍可分页读取、显式迁入、单服务启停/更新/删除，原完整定义不被简化。

全局占用回归用真实 HTTP POST 收件后断线，证明主工具已终结仍报告未知，模型、技能来源、MCP 和托管清单四类保存均拒绝，原四文件逐字节不变；其余原判别覆盖浏览器、命令、服务写、服务检查、应用数据及浏览器绑定，已核实状态可释放。合法空 family 可继续使用；被索引/原任务引用的空或缺记录拒绝，输出满 32 项后仍检查未知版本。

托管档案 22 项回归覆盖导入/释放锁/重开及实际后台启动、无外部库时请求的目录/正文/引用证据、启停和逻辑移除后的历史 entry 不变、安全暂存/临时清单/孤立包、四层权限/链接/所有者及文件硬链接拒绝、未知顶层/节点/清单版本。额外旧技能快照回归构造不含新来源元数据的原格式，重开后原哈希仍通过，只追加新选择。

额外五文件扩展回归 `test/personal-tools.test.ts test/personal-browser.test.ts test/personal-service-operations.test.ts test/personal-app-data.test.ts test/personal-command-work.test.ts` 首轮并跑 183 条，182 通过、1 条既有本机工具管理用例遇到客户端 5 秒超时；不记这组为通过。随后诊断定向用例 1/1、当前 `npx tsx --test test/personal-tools.test.ts` 整文件 18/18 通过；独立上下文在纯 HEAD 副本运行同一定向用例 1/1 通过。原 `/tools` 等处理与客户端 5 秒时限未改，新增设置只在 `/settings` 执行，未发现可复现的本次回归；尚未确定初次超时原因，保留该事实，未扩大原时限或将首次并跑改记为通过。

## 独立实现审查

独立上下文 `/root/profile_review` 直接读取工单、共享规格、实际差异、相关调用方和最终文档，亲跑最终设置及外部占用 32/32；技能/托管与 MCP 六文件组合 78/78。实际 `personal-entry.ts settings` 子进程分别验证未知 exec 操作、v99、父进程持 EXCLUSIVE 锁及过期修订，均退出 1、只返回一行版本/产品明确的结构化错误，原文件不变，未知命令没有执行。另实际装载旧 HEAD MCP parser，证明 v1 原样读取、v2 拒绝。

审查中发现并修复模型诊断请求缺持久证据、大 MCP 配置错误套用请求上限、非 MCP 未核实外部占用遗漏及目录选择误拒合法外部链接，最终无未解决实现阻断。权限矩阵初轮反复导入的夹具曾被共享临时祖先并发变化保守拒绝，改为单次导入、逐项破坏/恢复同一隔离档案；独立并跑 78/78，安全校验没有放宽。

## 验收与下一责任人

本单后端工程验收及独立审查已通过。产品主观体验不适用本单：GUI 在 08、真实 SSH/systemd 停存启与双外壳组合在 07/09；本地替身不替代这些验收。下一责任人为 07 实施者，消费版本 1 JSON、`PersonalSettingsRequest`、档案身份/两类技能修订以及只读生命周期事实；现有 `automaticRestart:false`、`originalEnvironment:unverified` 不能视为可自动恢复授权，原控制协议不能冒充新连接。

未跑全量 `npm run check`、真实模型/MCP/IM、真实 SSH/systemd 或 GUI；这些环境需后续按原部署与凭据前提验收。拥有者已授权提交，未授权推送、合并或部署。逻辑移除与失败残留保留字节，MCP 显式迁入后旧程序拒绝新配置，不能通过降版或删除历史恢复。

## 提交授权

2026-10-21，拥有者明确要求「提交」，据此将本单实现、文档和验收记录提交到当前分支，不推送。行为未变，沿用上述定向测试与独立审查证据；提交钩子执行行尾与完整静态检查，真实环境缺口继续保留。
