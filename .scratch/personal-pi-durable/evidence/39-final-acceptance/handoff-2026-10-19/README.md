# 39：2026-10-19 接手与当前候选

Status: in-progress

本次从HEAD `b1e975437f4cd3ca8084a8b07e451f19ba80ba17`及已有脏工作区接手，不改写以前的失败或成功结论，不提交、推送或接管生产。工程责任由根Agent持有，Coding证据、服务输入边界及NapCat路径各由独立上下文只读核对。

## 实际新事实

接手时v3清单只有643/649匹配，6份差异为personal-harness、personal-service-operations、personal-service-work、personal-work-tools、personal-work与对应服务测试。它们补充当前宿主服务事实，解决取消未消费操作的通用工具中断被旧上下文误判为效果未知；旧v3制品不能代表这些新代码。[原始差异](source-delta.json)与[v3差异补丁](service-facts-v3-delta.patch)保留接手时内容。

[QQ当前正式GET](qq-control-actual.json)核回原委托792：807已取消并停止，824未消费且source_inactive/已知未执行；870复用同一身份801却未申请第二次重启，576字符子回答和878字符正式报告仍误要求核实，报告已sent。服务计数3，后台tasks0/inputs0、pending检查0；本次不重放原委托、命令、服务或报告。当前真实QQ批准仍缺，已经成功的单项取消无需本人重复。

NapCat当前首错已由本人提供启动日志明确为macOS原生模块加载的Team ID/Library Validation拒绝；Mac Installer没有宿主重签流程，候选静态签名成功不能证明实际宿主加载。拥有者本轮选择Linux/Docker；[独立候选准备](../business/napcat-docker/prelogin-safe-summary.json)固定官方arm64基础digest及已验真4.18.38 Shell包，是本地派生镜像，未称官方现成4.18.38镜像。数据为全新私有目录、restart=no、privileged=false、no-new-privileges、6099/3001仅回环；native loaded成功，未自动复制账号/配置或连接personal。扫码材料只存私有临时文件，不入库。

## 服务事实引用返工与证据

独立审查复现未知callId的伪造assistant/toolResult仍进入实际HTTP；[原回归红](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fservice-reference-red.log)保留。修复在已有服务事实映射后，沿本身份原terminal pi.tool、结果entry/byTaskId及原assistant补核尚未匹配的服务结果；合法接纳前拒绝仍可进入模型，但没有操作事实；未知或歧义在provider前拒绝，不额外放宽缺结果的合成输入。实际input/payload保存投影，旧entry不改，批准、消费、取消、效果与停止状态机均未改变。

[五条原绿](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fservice-reference-green.log)和[最终六条](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Fservice-boundary-6-final.log)覆盖取消复用、原结果改写零HTTP、成对移出上下文后相同callId、重复调用歧义、未知callId零HTTP及接纳前参数错误零操作。移出贡献用durable ContextEdit，不称完整真实compaction；独立另核正常compaction不切开原调用与结果。新输入未证真实模型或私人IM结果。

macOS Node24：初四文件164/164，返工后四文件168/168（最后添加的参数拒绝正例另在六条检查）；work/delegations/scheduler/controls四文件87/87。Linux独立实体副本Node24服务/work-tools/reports通过，Node22六条边界通过，原日志见[24](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Flinux-service24.log)、[22](../../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2F39-final-acceptance%2Fhandoff-2026-10-19%2Flinux-service22.log)。Node24整文件发生在最后仅新增参数拒绝测试之前，不能改称同一全矩阵。静态与build通过，生成个人75/Coding6成员；[当前源码清单](source-manifest.json)、[macOS制品](macos-artifacts.json)绑定实际内容；后续源码再变须重定范围。

## 2026-10-19 晚更新

交接的四项待办已由新接手上下文推进，新增事实、证据与边界见[本轮记录](round3/README.md)：本人扫码登录的新 Linux NapCat 4.18.38 已用真实引导向导按新代次重新配对（新边界消息 id 698476783），旧回环目标无监听；当前候选已在隔离验收后台运行；真实 QQ 新委托复用原身份申请一次专用服务重启，本人原入口批准一次后计数 3→4，唯一报告 557 字符与宿主事实一致；真实 QQ 新图已产物化并实际入模，模型读出图内“Steve3957”。独立终审无阻断，[A1 失败账本](a1-failure-ledger.md)保留未归因项、不关闭门槛。Linux 制品与本轮子服务族测试日志已入档。

## 当前待办

1. 拥有者决定 A1 三项历史未归因失败（原17 macOS 身份查询、原17 Linux local 停止未核实、原38 native101 identity_unavailable）的处置：作为披露性残余风险进入候选，或继续留待验；Agent 不自行关闭门槛。
2. 是否提交、形成可发布 commit/PR 以及发布候选说明，需拥有者授权；当前候选仍为未提交工作区，清单与补丁见[候选绑定](round3/candidate-bindings.json)。
3. Telegram 本轮无新真实证据（旧回环代理停、入口不可用）；如需本轮环境下的 TG 复验，需恢复通道或另定范围，不用 QQ 事实替代。
4. 生产接管、窗口与回退授权仍归 40，不在本单隐含。

39仍in-progress；工程侧已完成本轮 Agent 可做的组合复验，生产接管仍由 40 另获目标/窗口授权后执行。
