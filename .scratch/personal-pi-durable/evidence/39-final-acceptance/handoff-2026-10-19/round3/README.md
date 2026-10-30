# 2026-10-19 晚：新 Linux NapCat 入口接入与真实 QQ 组合复验

Status: in-progress

本轮由根 Agent（新的独立执行上下文）接手，从交接记录继续。工作区仍是基线 `b1e975437f4cd3ca8084a8b07e451f19ba80ba17` 之上的未提交候选；没有提交、推送、切生产或重放旧失败。本页只记录本轮新增或复核的事实；旧失败原文与旧证据不改写。

## 本轮完成

1. 新 Linux/Docker NapCat 4.18.38 已由本人扫码登录，与旧绑定账号一致（bot 1529851498、拥有者 2729290885、互为好友），版本与镜像 digest 见 [QQ 入口复验](qq-entry-repair.json)。
2. 用仓库真实引导向导重新配对 QQ 入口，不是手写配置：新代次 `2bc7e55e-cbb6-4ea8-bbb3-7885bde20b27`、`ws://127.0.0.1:3001/`、边界面包消息 id `698476783`、tokenDigest 已更换；旧回环目标 33139/33140 在远端与本机均无监听，未双收发。配对原文见 [配对日志](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fpairing-cli.log)，其中只有短语与账号，无凭据。
3. 以当前候选源码启动隔离验收后台：远端检出 649/649 与 `source-manifest.json`（b2fa5776…）逐字节一致，worker 四项哈希一致，package-lock 446035b1…；启动后 tasks0/inputs0、默认与 QQ 均 auto-review、服务长期授权 0。绑定见 [候选绑定](candidate-bindings.json)。
4. 真实 QQ 组合复验通过：本人发新独立委托（平台消息 699613560），模型建立委托 918、复用原身份 agent 801、工作 928，仅一项服务操作 950；本人在原入口发 `/审批`（消息 815311032）并引用回复「批准本次」（消息 1427002127）一次后执行重启，测试服务计数 3→4（`starts.log` 唯一新增行 `2026-10-19T13:41:10Z`，MainPID 3463107→4105943）。委托唯一报告任务 941，delivery=sent，557 字符正文与宿主事实逐句一致，未要求再次审批或再次 report，无二次重启与其它业务。原始采集见 [QQ 审批与重启采集](qq-approval-image-collect.json)、[消息 id](qq-approval-message-ids.json)、[轮询日志](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fapproval-poll.log)。
5. 真实 QQ 图片链路通过：本人发送新图（不重投旧失败），回执属新代次，持久产物 `74329dfe-c2b8-4aac-a98a-094be1018293`（11464 字节 PNG，sha256 24ba983e…），模型输入含 image part，实际请求 payload 第 190 条消息第 3 个 part 为 `input_image` 且映射到同一 sha；模型正确读出图内文字“Steve3957”和棕色卡通猴子。同图已复制为 [原图](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fqq-image-39.png)，根 Agent 独立读图与模型描述一致，故计真实入模。
6. Linux 侧补齐最终候选的子服务族测试：Node24 32/32、Node22 32/32，包含最后新增的「接纳前参数错误可核实且重复callId不增加操作」，日志见 [Node24](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Flinux-final-boundary24.log)、[Node22](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Flinux-final-boundary22.log)。
7. 独立上下文终审与 A1 失败账本已交付：[独立终审](../independent-final-review.md)、[A1 失败账本](../a1-failure-ledger.md)。终审范围无阻断；A1 门槛不关闭，三项历史停止/身份查询失败仍未归因。
8. 本轮改动后重新运行 `npm run check:static` 通过（[日志](../../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fround3%2Fstatic-round3.log)）；此前服务事实补充的独立复审材料也从临时目录归档为[本次复审](prior-service-facts-review/review.md)（含其证明用例与源码清单）。
9. 发布候选说明（身份、依赖/制品、配置前提、检查结果、已知限制与恢复步骤）已按工单要求整理到[release-candidate.md](../../release-candidate.md)；报告正文与宿主事实的逐句核对见[委托918核对](report-918-verification.md)，最终后台状态见[final-state.json](final-state.json)。

## 独立终审提出的记录修正

- 原 `linux-node24.log` 与 `linux-service24.log` 字节相同、只有 133 条，早于最终测试文件，缺最后两条；本轮改为上面的新 Node24/Node22 子服务族日志，原文件保留不动。
- `source-delta.json` 只到 v3 时点；终态的 `personal-work.ts` 与测试增量不在其中，以 `source-manifest.json`（b2fa…）和本轮 [候选补丁](candidate-diff.patch)（64 个已跟踪文件，f462a337…）为准。
- Linux 制品记录此前只在远端临时目录；本轮归档为 [Linux 制品](linux-artifacts.json)，其包与 worker 哈希已与远端实际制品逐字节复核，且与 macOS 记录同绑同一源码清单。
- 根目录旧 `changes.patch`/`implementation-diff.json` 仍是 v3 时点，本轮新增 `candidate-diff.patch` 绑定终态补丁，不改写旧文件。

## 仍未验证或不能宣称

- A1 的三项历史未归因失败（原 17 macOS 身份查询、原 17 Linux local 停止未核实、原 38 native101 identity_unavailable）保持独立边界；本轮新绿不构成归因，发布候选是否接受为披露性残余风险需要拥有者决定。
- Telegram 本轮没有新真实证据：旧回环代理已停，入口报接收不可用。此前真实 TG 证据只在原环境与范围内有效，不用 QQ 成功替代。
- 没有最终可发布 commit（未获提交授权）；候选仍是工作区，生产接管与窗口仍归 40。
- 本轮是真实 DeepSeek 模型与真实 QQ；图片与报告为真实 IM 事实，但服务目标是专用被控测试服务，不代表业务健康。

## 拥有者处置与本地提交

2026-10-19 晚拥有者决定：A1 三项历史未归因失败按披露性残余风险收口，不声称已归因或修复；据此 39 记录工程验收通过并置 resolved，同时授权把候选提交为本地 commit（不推送、不部署）。提交前对整个证据目录做了凭据扫描（含 gz 解压与 tar.gz 成员），四类凭据与通用模式零命中，见 [凭据扫描](credential-scan-2026-10-19.json)；文件名含 private 的模型/平台原始载荷与 model-private 目录不入库，保留在本机私有位置。候选 commit 记录见 [commit-record.json](commit-record.json)；其中未提交的三项私有/无换行副本已按拥有者指示删除，等值字节保存在已提交归档包的同名成员中（复核方式记在该记录的 `cleanup` 字段）。本单通过仅表示可安排 40，生产目标/窗口/接管授权仍由拥有者另行确定。
