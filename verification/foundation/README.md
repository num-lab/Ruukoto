# 阶段 0 基础验证（issue 01）

运行要求 Node ≥24.15，与根工作区的支持范围一致。

验证 pi（`@earendil-works/pi-coding-agent` 1.3.0）的公开 API：并发会话、完整磁盘历史、可控模型上下文、工具与扩展，以及 Linux 受限执行边界。本目录是验证脚手架；关键结论与复跑入口保存在下文，阶段 0 的完整本地调查记录位于`.scratch/personal-agent/foundation-findings.md`。

模型服务复用仓库内的 `test/helpers/mock-provider.ts`。使用完整仓库，以下命令均在仓库根目录运行；环境、提交钩子与全部检查入口见 [开发说明](../../docs/development.md)。

## 运行

```bash
npm run setup            # 按根目录与本目录的锁文件安装依赖
npm run test:foundation  # 本目录全部离线验证（mock 模型，不联网、不需要凭据）
npm run typecheck        # 应用与本目录一起检查
npm --prefix verification/foundation run test:model   # 真实模型短往返，走本机 pi 凭据
npm run linux:probes     # Linux bubblewrap 原生边界探针（需要已安装的原生前置）
```

## 验证项与结论索引

下面保留阶段 0 的历史结论，当前检出是否通过以复跑结果为准。后续产品与原生 Linux证据见 [发布验收的历史验证清单](../../docs/release-acceptance.md#历史验证清单)。

| 测试（路径相对 `verification/foundation/`） | 验证内容 | 结论 |
| --- | --- | --- |
| `test/01-compaction.test.ts` | 自动压缩可关闭；扩展可拦截压缩；磁盘历史完整 | ✅ |
| `test/02-context.test.ts` | `context` 事件逐轮选取模型输入，磁盘原文不动 | ✅ |
| `test/03-tools.test.ts` | 内置 `bash` 直接复用及结果回传 | ✅ |
| `test/04-sessions.test.ts` | 同进程并行多会话、事件独立、状态互不串用 | ✅ |
| `test/05-plugin.test.ts` | `customTools` 参数和调用配对、结果回传，以及可信插件的权限/生命周期/存储 | ✅ |
| 历史 RPC 探索（`git show 28c033f7:verification/foundation/test/06-rpc.test.ts`） | 子进程 JSONL 驱动与事件流；产品未采用该入口，退出当前集合 | 历史通过 |
| `test/07-connectivity.test.ts` | 真实模型连通（默认跳过，RUN_MODEL_CHECK=1 开启） | ✅ deepseek-v4-flash |
| `scripts/linux-isolation/` | 容器受限执行边界探针（文件/子进程/网络/凭据/控制面/系统身份） | ✅ 31/31（Docker Desktop Linux VM） |

## 当前接线与历史 SDK 行为

当前两产品固定 Pi 1.3.0，Code 经公开 `discoverAndLoadExtensions` 加载显式宿主模块，以各 SDK 的 EventBus 注入依赖；MCP 使用官方 factory 与注册表。模型请求使用 `TranscriptContext.messages` 的系统条目保存提示和工具，发送前复核及快照读取同一份最终消息。

下列为阶段 0 的历史调查结论，不能据此替代当前产品接线；迁移依据见[MCP宿主职责收缩](../../.agents/notes/implemented/simplification/2026-10-26-mcp-host-responsibilities.md)。

- `createAgentSession()` **不接受** `extensionFactories` 选项（静默忽略）；inline 扩展必须经 `DefaultResourceLoader({ extensionFactories })` 传入。
- SDK 路径下 `session_start` / `session_shutdown` 不会派发给 inline 扩展（CLI 交互模式才有）；每轮 `before_agent_start` / `agent_start` / `agent_end` / `agent_settled` 可靠。
- `SessionManager.create()` 惰性创建 JSONL 文件：首次写入前`session.sessionFile` 为 `undefined`。
- `ModelRuntime.create()` 必须显式传 `authPath`/`modelsPath`/`modelsStore`才能做到封闭（否则读取用户 `~/.pi/agent`）。

## Linux 探针说明

当前 `npm run linux:probes` 运行 [Linux 原生探针](scripts/native-isolation/linux-README.md)，使用正式 `/usr/bin/bwrap` 与独立 user scope，不依赖 Docker。产品验收使用 [原生 smoke](../smoke/README.md)。

[旧容器对照](scripts/linux-isolation/README.md)保存退役策略；它在容器内运行 `probe.py`，历史范围包含：

- 文件：工作区可写、宿主路径不可见、工作区外写入拒绝
- 子进程：可正常 spawn；restricted 变体断言 CapEff=0；mount 被拒绝
- 网络：`--network none` 下外网不可达
- 凭据：环境变量无凭据、无 `~/.pi` 配置
- 控制面：宿主回环监听端口从容器不可达（回环与网关两种路径）
- 系统身份：root 持有的 0600 控制面状态，任务 uid 读写均被内核拒绝

结果写入 `verification/foundation/results/linux-isolation-report.{json,md}`。注意：阶段 0 的运行环境是 Docker Desktop（macOS 上的 Linux VM，linuxkit 6.12.76 / Debian 13），验证的是**容器边界本身**；该阶段尚未验证目标 Linux 服务器的宿主前提（发行版、内核、rootless 运行时），后续实机记录见上述运行文档。

## Coding Agent 原生边界验证（工单 26）

`verification/foundation/scripts/native-isolation/` 保存 Seatbelt / bubblewrap 的可复跑真实探针，步骤与退出码见[运行说明](scripts/native-isolation/README.md)。2026-10-08 第一阶段未通过：macOS 的原生候选尚未实现脱离进程组后代的完整回收，tx 的 bubblewrap 在 namespace 建立时被系统拒绝；报告保存在 `verification/foundation/results/native-*`。这些旧结果不代表当前产品验收；两产品受限 worker 共用原生入口，实际产品结果由 smoke 独立记录。
