# 工单 29 工程证据

2026-10-18（东京时间），从干净基点 `93eac52a715d03f5e8432fd4d34670ad4e83a4d7` 实施[通用工具、资料授权与产物](../../issues/29-tools-access-artifacts.md)。本机为 macOS arm64、Node 24.15.0。使用独立开发档案、本地模拟模型和回环 HTTP；没有使用真实模型、IM、Tavily 凭据或生产档案。以下证据只证明相应工程行为，不代表完整 A1–A12 或正式切换通过。

## 实现与旧能力映射

| 原入口 | 个人 durable 实现与验收边界 |
| --- | --- |
| `tool-availability.ts`、`tool-router.ts` | `personal-tools.ts` 注册五项原生 `pi.tool`，主/子共用名称和来源门；沿原工作权限，未知并入委托、报告及 HTTP/MCP 端点占用。没有引用旧 ToolRouter 或任务账本。 |
| `approved-ops.ts`、旧文件/HTTP 审批 | 复用普通文件执行与固定 HTTP 请求；新接纳保存参数、目录/文件身份、DNS、配置版本及批准，执行前复核。Linux 新建使用父目录句柄；macOS 只修改已有文件，明确拒绝新建。 |
| `review.ts` | 复用策略及严格结果解析，实际独立 provider 请求没有工具；claim、规范输入和实际 payload 先保存，仅正常完整回复可裁决，失败转拥有者。 |
| `web-search.ts` | 抽出纯 Tavily transport，旧 CredentialStore 包装与导出保持；durable 保存原响应产物，普通模型视图有界，原生 schema 拒绝的搜索意图也计入每来源五次额度。 |
| `artifacts.ts` | 新私有不可变原字节文件及 durable 来源引用，分页校验身份/长度/SHA-256，独占导出；命令/MCP 沿已有原引用，不复制正文，不引入旧 core Db。 |
| 旧拥有者操作 | 本机向导、认证接口及 Telegram `/工具`，明确批准/拒绝、效果和远端结束分别核实、资料授权与撤销、原产物导出。Telegram 只离线核对原入口记录，尚未真实体验。 |

决定及被拒方案见[架构笔记](../../../../.agents/notes/implemented/architecture/2026-10-17-personal-tools-access-artifacts.md)。当前 38 项源码、测试和常驻文档由 [source-manifest.json](source-manifest.json)与[源码归档](source.tar.gz)固定，根已[逐项核对归档和当前字节](root-source-verification.json)；清单不包含本页、工单和证据，避免递归指纹。

## 本机检查

下表有重复覆盖，不将各行直接相加。每条命令均以 `RUN_MODEL_CHECK=0` 的离线前提运行；没有跑全仓 `npm run check`。

| 范围 | 实际命令与结果 |
| --- | --- |
| 既有 MCP、工作、命令及共享审批 | `npx tsx --test test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-work.test.ts test/personal-command-work.test.ts test/08-approvals.test.ts test/22-auto-review.test.ts test/62-tool-availability.test.ts`：118/118，213.83 秒；原输出保存在本轮工具执行历史，没有伪造原始日志。 |
| IO、产物、配置、控制与共享搜索 | `npx tsx --test test/personal-artifacts.test.ts test/personal-tool-io.test.ts test/personal-tool-fifo.test.ts test/personal-tools-controls.test.ts test/personal-tools-config.test.ts test/08-approvals.test.ts test/23-web-search.test.ts test/web-search-transport.test.ts`：[日志](io-regression-final.log)80/80；当时 IO 为 14 项，之后新增截短异常用例另验。 |
| 实际调用方 | `npx tsx --test test/personal-durable.test.ts test/personal-cli.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-delegations.test.ts test/personal-reports.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts test/personal-mcp-controls.test.ts test/personal-mcp-config.test.ts test/71-product-entry.test.ts`：[日志](callers-regression.log)313 项中 312 通过、1 个既有 Linux sudo 场景在 macOS 跳过。 |
| 原生工具核心 | `RUUKOTO_TOOLS_EVIDENCE=.scratch/personal-pi-durable/evidence/29-macos/model-requests-final npx tsx --test test/personal-tools.test.ts`：[初次最终日志](tools-tests-final.log)16 项中 15 通过，资料授权用例超过原 20 秒预算；并发文件身份检查使该例耗时 21.53 秒。只把预算改为 60 秒，断言不变，[同例重跑](confirm-final.log)1/1、10.90 秒。 |
| 文件写后强杀 | `npx tsx --test --test-name-pattern='durable 文件写入：写后强杀' test/personal-tools.test.ts`：[日志](file-crash-final-2.log)1/1；真实 SIGKILL 后不重写拥有者后改内容，效果未知、本地已结束，核实后解除来源暂停。 |
| 真实本机认证路由 | `npx tsx --test --test-name-pattern='durable 本机入口：真实认证接口' test/personal-tools.test.ts`：[日志](control-api-final-2.log)1/1；实际后台完成批准、资料授权/撤销、原产物独占导出。 |
| 截短失败回归 | `npx tsx --test --test-name-pattern='截短已开始后异常\|文件写入开始后' test/personal-tool-io.test.ts test/08-approvals.test.ts`：[日志](truncate-final-2.log)2/2；实际截短再抛错必须保持未知，原 fsync 失败分类仍通过。 |
| 配置保存故障重试 | `npx tsx --test test/personal-tools-config.test.ts`：[最终日志](config-tests-final.log)3/3，首次及已有配置写盘失败后均可安全重试。 |
| 构建与静态 | `npm run build`：[日志](build.log)通过；`npm run check:static`：[首次全绿日志](static-final-3.log)通过。交接修改后的[最终静态日志](static-handoff.log)退出 0，包含类型、lint、文档预算/链接/换行与笔记门禁；`git diff --check` 通过。 |

核心最终共 18 个不同用例，原 16 项加文件强杀和真实接口两项均已实际通过，未声称一次全文件运行 18/18。配置和截短首轮失败来自测试夹具：前者试图直接改只读 ESM namespace，后改用 Node 内置模块同步导出；后者错误解构文件路径。真实接口首轮误用 `POST /input`，改回既有 `POST /inputs`。对应失败日志 `config-tests.log`、`truncate-final.log`、`control-api-final.log` 原样保留。早期静态失败为缺决策锚点及文档预算，修正后全绿；没有提高预算。

实际模拟模型请求保存在 [model-requests-final](model-requests-final/)及[授权用例重跑](model-requests-confirm-final/)，包含主/子三模式和无工具审查输入，可与 durable payload 对照重建。按字符数除四估算，启用前主 system/tools 为 51/521，子为 38/1；启用后三模式主为 51/1391，子为 38/870。这是 macOS 当前描述的估算，不是实际 token 计费，也不声称 Linux 描述字节相同。

标准文档门禁不扫描 `.scratch/`；另用仓库 Markdown 解析器显式核对本轮 7 份工单/交接/证据 Markdown 的相对链接与锚点、段落、单一 Status 和末尾换行，见 [scratch-markdown-check.json](scratch-markdown-check.json)。

## 独立审查与 Linux

[独立终审](independent-review/README.md)覆盖 22 个不同仓库用例和四项附加真实 Harness 流程，无未解决阻断；两项实际撤修复反证分别捕获 SDK 参数标准化及截短后的错误分类。终审作者不为自己实现的搜索 transport 作独立通过结论，该叶模块另由 IO 上下文核对并在 Linux 运行。根亲自复核审查的 28 项源码/测试哈希均相同，见 [root-review-verification.json](root-review-verification.json)。

[Linux 四场景与叶测](../29-linux/README.md)证明实际 bwrap/scope 的允许/越界行为、confirm 与 auto-review 相同受限命令环境，以及 HTTP 写后强杀只发一次、效果和远端结束双事实释放。最终 IO/Search/FIFO 28/28；47 项最终源码/worker、115 份归档记录及 42 份交付材料由根逐项核对，见 [root-verification.json](../29-linux/root-verification.json)。四场景原源码与后加截短分支的差异及独立增量证据已明确区分。原 scope、临时目录及专属远端目录清理完成，根再次通过 SSH 核对，见 [root-remote-cleanup.json](../29-linux/root-remote-cleanup.json)。

## 待验与限制

真实模型、Tavily/MCP 服务、Telegram/其他 IM 与拥有者主观操作体验尚未验证；由工单 35/37/39 在对应候选和专用环境补证并回写。本机认证接口真实通过不代替真实 Telegram 控制体验。正式 bin/生产入口未切换，未提交、推送或部署。

新建文件只在 Linux 支持，其他平台明确拒绝；文件/HTTP 每次最多 8 MiB、Tavily 256 KiB，超限或中断保留 partial，完整导出拒绝 partial。没有全档案磁盘配额；已发布但缺 durable 引用的私有文件保留，不自动清理。凭据回显拒收或脱敏，不能承诺秘密的原字节导出。HTTP 无远端查询协议时，未知请求仍需拥有者提供独立效果及结束证据；本地断线不释放占用。
