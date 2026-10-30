# 30 本机工程证据

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

对应[工单 30](../../issues/30-browser-media.md)，起点 `1bd0d021ca1ed1432abd2b69f087d402ed22eb5f`，macOS arm64、Node 24.15.0。所有模型 HTTP 均为 loopback 替身，Telegram 下载/发送为替身；没有使用真实视觉模型或真实 IM。最终源码指纹由 `implementation-manifest.json` 持有，独立审查见 `independent-review.md`。

`npx tsx .scratch/personal-pi-durable/evidence/30-macos/verify-handoff.mts` 核对工单/证据链接与格式、45 项实施指纹、Linux 源码差异和 15 项归档内容，结果在 `handoff-check.json`；`handoff-manifest.json` 保存本轮交接工单和证据文件的指纹，不包含自身。

## 检查与覆盖

| 命令或范围 | 结果与材料 |
| --- | --- |
| `npm run check:static` | `static-handoff.log`、测试断言修正后的 `static-delivery.log` 均通过。包含 lint、全部 typecheck、notes 和 docs 门禁。 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-media.test.ts test/personal-browser.test.ts test/personal-browser-integration.test.ts test/personal-artifacts.test.ts` | 55/55，`media-browser-final.log`；媒体限额、归属、重投/换代/恢复、原字节和绑定、模型能力、浏览器权限/未知/停止/反链、本机接口及组合。 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-media.test.ts test/personal-durable.test.ts test/personal-cli.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts` | 该轮 media 为 11 项，合计 105 项中 104 通过、1 项原有 Linux sudo 专用跳过，`callers-final.log`；本机菜单、持锁退出、Telegram 接纳与原权限调用方。后补 3 项 media 由 55 项组及最终 207 项组覆盖。 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/browser-lifecycle.test.ts test/browser-tools.test.ts test/62-tool-availability.test.ts test/111-workflow-capabilities.test.ts` | 65/65，`coding-final.log`；共享 BrowserManager 改为等待持久回调后的 Coding 调用方。 |
| `RUN_MODEL_CHECK=0 npx tsx --test test/personal-tools.test.ts test/personal-work.test.ts test/personal-reports.test.ts test/personal-service-operations.test.ts test/personal-mcp.test.ts test/personal-media.test.ts test/personal-browser.test.ts test/personal-browser-integration.test.ts` | 最终合并回归 207/207、零跳过，见 `cross-tools-handoff.log`；额外设置 `RUUKOTO_TOOLS_EVIDENCE` 保存 `cross-tool-snapshots/` 原始请求。五个旧能力文件的前轮单独回归 168/168，见 `cross-tools-diagnostic-2.log`。 |

重叠组不累计为唯一用例数。未跑全量 `npm run check`、完整构建和新一轮 Linux setup；没有依赖、打包或正式入口变动。Linux 的定向执行和环境缺口见[独立 Linux 证据](../30-linux/README.md)。

## 真实 macOS 浏览器

`RUN_MODEL_CHECK=0 npx tsx .scratch/personal-pi-durable/evidence/30-macos/browser-probe.mts` 使用官方 agent-browser 0.39.1 arm64 程序和系统 Google Chrome、临时个人档案及本机网页；程序 SHA-256 为 `cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef`。临时程序路径记录在结果中，重新运行须提供可用程序与 Chrome。`browser-probe-final.log` 和 `browser-probe-result.json` 证明启动/导航、3 个 snapshot 引用、7000 字节 PNG 经真实 provider 转为图片输入、本机原字节导出、pause/resume 功能路径，以及后台在导航期间 SIGKILL 后恢复关闭旧浏览器且不重发。取消场景也只收到一次网页请求；两种中断均保留 `effect_unknown` 与 `stopped: true`，原来源暂停，独立聊天可继续。关闭后的状态没有失效的 dashboard 地址。探针清理临时档案与进程，没有打开生产档案。

初轮 `browser-probe.log` 错把 provider 添加的 user 图片块当最后 tool，第二轮 `browser-probe-2.log` 在事务外读取 overlay；均为探针问题，修正后第三轮与最终轮通过。保留早期失败，不把替身模型识图记为真实视觉验收。

## 实际请求与模型可见文本

`RUN_MODEL_CHECK=0 npx tsx .scratch/personal-pi-durable/evidence/30-macos/media-independent-review-probe.mts` 实际捕获 openai-completions、openai-responses、anthropic-messages 三种 SDK 的 fetch payload，核对图片字节和留存引用，结果见同名 `.log`。这证明传输结构与重建，不能证明真实模型理解图片。

`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='browser仅主会话' .scratch/personal-pi-durable/evidence/30-macos/prompt-snapshot-probe.mts` 保存最终 browser 描述及实际 HTTP 请求到 `prompt-snapshot-requests.json`，`prompt-snapshot-final.log` 通过。`tool-estimates-final.log` 与 `tool-estimates-final/requests-1.json` 保存最终 general 描述及实际请求。估算采用字符数除以 4 向上取整，不是供应商 tokenizer：无 general/browser 的主/子 system 为 51/38，tools 为 637/1；仅 browser 的原完全访问主 tools 为 1118、受限主仍 637、子仍 1；有 general 的三模式主 tools 均 1406、子 886，system 不变。两项能力单独估算，不能相加当组合实测。

## 中间失败与修正

提交时仅移除 `core-initial.log`、`cross-tools-diagnostic-3.log`、`cross-tools-final-2.log`、`cross-tools-final.log` 的行尾空格/制表符，原字节完整保留在 `failure-logs-original.tar.gz`；各文件前后 SHA-256 和归档指纹见 `failure-log-normalization.json`。没有改写失败内容或计数。

`core-initial.log` 保留初轮失败：Telegram 在 append accepted 后扫描任务违反 durable 的先读后写约束、本机导出将事务 overlay 带出事务、无 browser 时多一次 await 使旧失败存储测试来不及释放锁等；修正后由上面的最窄用例和调用方复核。`static-initial.log` 是共享 pause 变 async 后未同步的测试替身；`static-final.log`、`static-final-2.log` 是 README 超预算，修正后静态通过。

`cross-tools-final.log` 暴露旧测试在接纳后才设置模式、假设 root 没有独立产物 reader，以及 MCP 在描述中误匹配工具名；夹具改为接纳前设模式、跨权限场景使用不同真实来源、核对实际工具名。该轮一个等待旧批准的测试进程被定向终止，未计通过。`cross-tools-diagnostic.log` 的诊断输出目录未创建也保留，后续先建目录。

`cross-tools-final-2.log` 与 `cross-tools-diagnostic-3.log` 另暴露旧的“快照数等于 HTTP 数”断言；`payload-retry-observed.json` 保留 14 份准备快照和 13 次 HTTP，唯一多出的是相邻完全相同快照。独立 `payload-retry-probe.mts` 在首次 fetch 到达 HTTP 前抛连接错误，原生 durable 重试产生 2 份相同 payload、2 个 requestId、1 次 HTTP 和 1 条 `Connection error.`，见同名前缀 result/records/log。原并行失败的具体连接错误没有单独保留下来，因此不把这个反例写成其唯一原因。最终测试比较相邻去重后的两边序列，并逐条核对实际 HTTP 有完整原始快照；保留全部原证据，不删除生产记录或把准备记录冒充送达回执。

## 待验收

真实视觉模型、Telegram 实际图片与浏览器控制、操作者菜单体验继续待验；QQ 接线属于 31，两平台完整矩阵属于 39。浏览器未知动作会保守关闭页面，页面现场可能丢失；停止不证明网页写入未发生。未设置全档案磁盘配额，绑定图片保留，24 小时未绑定图片先记失效再清理。
