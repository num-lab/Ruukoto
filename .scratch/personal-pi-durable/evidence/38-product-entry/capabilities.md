# 个人入口保留与退出清单

本单只替换入口与删除旧个人装配；下表的保留能力沿用 28–37 的实现，离线回归不替代各单尚缺的真实平台验收。源码基点为 `12b1a66c`，实际候选由本目录的源码与制品清单标识。

| 范围 | 当前入口与代码落点 | 清理或保留依据 |
| --- | --- | --- |
| 正式启动与本机管理 | `apps/ruukoto/src/main.ts` → `personal-cli.ts` → `personal-control.ts`；bin、根 start、兼容 personal-entry 同装配 | 不再导入旧 CLI、Runtime、Driver、Task Store 或控制面；实际 import 图与三入口重启用例验证 |
| 档案与恢复 | `personal-profile.ts`、`personal-harness.ts` | 正式默认新目录；开发按检出隔离；旧资料、未知版本与第二进程拒绝；不更改原件或新建兼容运行库 |
| QQ／Telegram 主会话 | `personal-qq-api.ts`、`personal-telegram.ts` 及各自配置/控制模块 | 保留拥有者核实、固定原入口与共享主会话；开发启动拒绝启用 IM 的档案，配对演练使用单独新目录 |
| 后台工作与长期子 Agent | `personal-work.ts`、`personal-delegation.ts`、`personal-report.ts` | durable Task/Submission/Conversation 继续是执行权威，身份复用、取消、未知暂停及固定回报保持 |
| 定时工作 | `personal-scheduler.ts`、`personal-schedule-authority.ts`、`personal-scheduler-tools.ts` | 使用 durable 计划/运行及原生 Task；只复用共享时间计算，不接旧计划/发送账本 |
| 记忆、技能与历史 | `personal-memory.ts`、`personal-skills.ts`、`personal-history.ts` | 新资料与输入证据留在 durable；复用的技能目录读取为无状态能力，不导入旧 MemoryStore 或 JSONL 写入装配 |
| 应用数据 | `personal-app-data.ts`，共享 `packages/agent/src/app-data/` | 保留独立业务 SQLite 与操作回执，不镜像旧任务状态；Coding 的共享业务库及其失败路径仍保留 |
| MCP、文件、命令、网络、浏览器、图片与产物 | `personal-mcp*.ts`、`personal-tools*.ts`、`personal-command*.ts`、`personal-browser*.ts`、`personal-media.ts`、`personal-artifacts.ts` | 继续复用明确的传输、校验、浏览器和原生执行原语；个人命令 worker 自包含、空 SDK 依赖；Coding worker 的 SDK/依赖保持 |
| 服务与三种模式、长期授权 | `personal-permissions.ts`、`personal-service-operations.ts`、`personal-service-inspection.ts`、`service-helper.ts` | 继续使用受控 helper 与原执行身份、权限和回执；helper 仍被新个人调用，不能随旧 service-tools 删除 |
| 开发入口 | `apps/ruukoto/src/dev.ts`、`personalDevelopmentEnv` | 薄启动器托管平台 watch；配置菜单直接复用同一 CLI，退出等待自己启动的后台停止；不使用旧共享开发启动器或旧开发档案 |
| 旧个人产品声明与模型工具 | 删除 `apps/ruukoto/src/product.ts`、`scheduler-tools.ts`、`service-tools.ts` | 无 Coding 生产调用方；不把旧工具搬进测试夹具。`test/helpers/legacy-product.ts` 仅声明共享旧格式测试所需的 RuntimeProduct，工具族为空 |
| 旧个人导入 | 删除 `packages/channels/src/personal-import.ts` 与只验证该方向的测试 | 新个人从零开始。Coding 的 `apps/ruukoto-code/src/legacy-import.ts`、core 导入支持、schema 与历史文件规则保留，仍从旧 ruukoto/未登记产品源读取开发资料 |
| 个人开发会话、worktree 汇总、旧工作流与 GitHub 自动评审 | 新个人无入口；相应旧底座代码仍供 Coding 或旧格式实现与资料核实使用 | 实际运行图退出旧装配；不能因此整包删除 Runtime、控制协议或共享账本，也不能声称 Coding 新增 IM／调度／GitHub 能力 |
| 旧个人桌面与 TUI | 新个人不接入共享协议；Coding 的 TUI、配置中心、Code 桌面和按需后台保持 | 旧 Personal SSH 客户端不是 durable 客户端；共享界面与历史投影仍有 Coding 调用方，不删除 |
| 旧个人外部复跑脚本 | 删除 smoke 18／27／28；04／13／15 改用 Coding 实际入口；24 验证两份 Coding 安装升级 | 历史证据原样保留，新真实模型入口继续使用 smoke-personal-durable；不以旧个人共享协议复跑冒充新入口验收 |
| 发布制品与部署模板 | `npm run build`、两个 app tarball、根 `worker/` 与 systemd `serve` 模板 | 实际独立安装、构建、解包替换与运行已另记证据；交付仍要求完整 workspace，未变成独立 app 发行版，也未安装或启动生产服务 |
