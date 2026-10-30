# 39 发布候选说明（2026-10-19 晚）

Status: 已由拥有者决定（A1 按披露性残余风险收口；本地 commit，不推送、不部署）

本页是[39](../../issues/39-final-acceptance.md)要求的发布候选固定说明：候选身份、依赖与制品、配置前提、检查结果、已知限制和恢复步骤。2026-10-19 晚拥有者决定：A1 的三项历史未归因失败按披露性残余风险收口，不声称已归因或已修复；候选提交为本地 commit 并据此记录工程验收通过，但仍不推送、不部署。本页只固定已核实事实与未验证边界。当前没有提交、没有推送、没有生产接管；实际切换仍由[40](../../issues/40-production-cutover.md)另获目标/窗口/授权后执行。

## 候选身份

- 基线 commit `b1e975437f4cd3ca8084a8b07e451f19ba80ba17`，候选为工作区未提交改动：61 个已跟踪实现/文档文件（[实现补丁](handoff-2026-10-19/round3/candidate-diff.patch)，247028 字节，sha256 `fe408f08c0898f37e48d1bc18e31567fef89b2530281079d32ed959241b49d75`，已排除 `.scratch` 验收记录）加 3 个未跟踪实现文件（`test/personal-mock-provider.test.ts`、`test/protected-path-batch.test.ts`、[批保护决策笔记](../../../../.agents/notes/implemented/bug-fix/2026-10-18-batch-native-protection-checks.md)）；另有 3 个已跟踪的 `.scratch` 验收记录（39 工单、39 证据 README、remaining-work）不属于实现补丁。
- 源码清单 [source-manifest.json](handoff-2026-10-19/source-manifest.json)：649 个运行/测试/构建文件，sha256 `b2fa5776314c602ac89ab719d454e912a2e7edccd5edb582cac1e77f3998752d`；本机与远端隔离副本均 649/649 逐字节匹配。
- 依赖锁 `package-lock.json`：470938 字节，sha256 `446035b166165717ce1b020e863152967296abeb0257f679427223e928ac159c`。
- worker 制品（两平台一致）：`worker.mjs` `ec4d1232…`、`personal-command-worker.mjs` `c1d8bc34…`、`workflow-script.mjs` `2e6719fd…`、`workflow-script.wasm` `105c3bed…`；macOS 另有 `native-macos-supervisor` `43441a96…`。
- 包制品：`ruukoto-0.1.0.tgz`（270239 字节，`59ce90b8…`，75 成员）与 `ruukoto-code-0.1.0.tgz`（23057 字节，`92255af7…`，6 成员），macOS 与 Linux 构建逐字节一致。
- 绑定与两 OS 制品记录见 [candidate-bindings.json](handoff-2026-10-19/round3/candidate-bindings.json)、[macOS 制品](handoff-2026-10-19/macos-artifacts.json)、[Linux 制品](handoff-2026-10-19/round3/linux-artifacts.json)。

## 配置前提

- Node 24.15.0（验收亦覆盖 Node 22.19.0）；Linux 需要 bubblewrap 与按路径 AppArmor 前置；远端为 Ubuntu 24.04 aarch64。
- 模型 `deepseek-flash`，`openai-responses`，上下文 1000000、最大输出 4096，支持图片输入；凭据只在后台环境变量中，不入档案。
- QQ 入口：专用 OneBot v11 正向 WebSocket，本机回环地址；本轮新代次 `2bc7e55e-cbb6-4ea8-bbb3-7885bde20b27`，配对边界消息 id `698476783`，拥有者与登录账号已由真实配对核实。旧回环目标必须停用，避免双收发。
- Telegram 入口保留原绑定配置；本轮其回环上游不在线，未产生新真实证据。
- 服务管理：专用 helper、`/etc/ruukoto/services.json` 白名单与 `ruukoto39-test.service`；sudo 仅该白名单。MCP、浏览器、命令目录、技能与资料授权沿隔离验收档案原配置。
- 单个 personal 存储只允许一个后台拥有者；配置向导与后台不能同时持锁。

## 检查结果

- 静态：`npm run check:static` 通过（lint、typecheck、verify-notes、check:docs），见 [本轮静态日志](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fstatic-round3.log)；构建 exit 0 并生成上述 worker、包与 75/6 成员。
- 独立终审（独立执行上下文，范围=6 份晚改动、两 OS 制品绑定、相关调用方/测试/文档）：无阻断，见 [independent-final-review.md](handoff-2026-10-19/independent-final-review.md)。
- Linux 子服务族：Node24 32/32、Node22 32/32，含原件撤销、未知调用拒绝与接纳前参数错误，见 [Node24](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Flinux-final-boundary24.log)、[Node22](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Flinux-final-boundary22.log)。
- macOS 定向：独立审查亲跑三文件 135/135、四文件 87/87、五文件 124/124，均 exit 0。
- 真实模型与真实 QQ：委托 918 复用原身份 801，仅一次对 `ruukoto39-test.service` 的 `service_restart` 经拥有者原入口批准一次后执行，测试服务计数 3→4（唯一新增启动行 `2026-10-19T13:41:10Z`、MainPID 更换），委托唯一报告 `delivery=sent` 且 557 字符与宿主事实逐句一致，无二次重启与其它业务；采集见 [qq-approval-image-collect.json](handoff-2026-10-19/round3/qq-approval-image-collect.json)。
- 真实 QQ 图片：新图 → 持久产物（11464 字节 PNG，sha256 `24ba983e…`）→ 模型输入 image part → 实际请求 payload `input[190].content[3]` 为 `input_image` 且映射同一 sha → 模型读出图内“Steve3957”；根 Agent 独立读图一致。原图见 [qq-image-39.png](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fqq-image-39.png)。
- 真实环境与 OS 边界、A12 隔离演练、A5 受限执行、A6 强杀等沿用已核叶证据；不同快照或不同环境不合成一次全绿。

## 已知限制与未验证项

- A1 三项历史未归因：原 17 macOS `identity_unavailable`、原 17 Linux `local` 停止未核实、原 38 native101 `identity_unavailable`；无可复现首故障，新绿不构成归因。审计结论见 [a1-failure-ledger.md](handoff-2026-10-19/a1-failure-ledger.md)。是否作为披露性残余风险进入候选由拥有者决定。
- 没有可发布 commit：候选仍是未提交工作区，提交/PR/发布授权未取得。
- 本轮 Telegram 无新真实证据（回环上游不在线）；此前 TG 证据只在原环境与范围内有效。
- 模型行为只按单次真实样本记录；报告正文准确性与模型是否再次误述不视为已永久修复。
- 服务目标为专用被控测试服务，重启成功不代表业务健康；A12 反例使用回环替身，生产切换边界未在本单验证。

## 恢复步骤

- 停止验收后台：通过本机控制接口请求停止并等待档案释放；连接断开本身不证明停止。配置向导只在后台停止后使用。
- 保留档案：`personal.sqlite`、各 JSON 配置、产物与凭据引用都不删除、不移动、不覆盖；恢复用原档案，不改写历史。
- 代码回退只回退代码，并用另一个全新空白档案重新配置；不加载本候选或旧档案中的任务、已登记入站、通知与计划，不重放旧积压。
- 入口回退：停用新 QQ 入口并核实旧目标未在线后，才能切回旧目标；平台接管边界须重新可核实，不能只改本地水位。
- 任何未知效果或停止未核实状态保留占用，按原核实入口处理，不换入口重试。
