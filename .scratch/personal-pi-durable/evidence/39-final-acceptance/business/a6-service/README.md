# A6真实服务故障窗口：效果完成后、结果提交前强杀

2026-10-18在oracle-4c24g的独立档案完成，driver exit0，约10.2秒。只对ruukoto39-test.service执行一次restart：辅助启动计数2→3，systemd InvocationID由9811888c0d074fc9bed074098cb38628变为6220900834c14d8597e2979d513947bf，最后active/running。counter由测试账户可写，只作辅助观察；InvocationID变化、固定helper完整回执与原执行结束证明共同支持本轮结果，不把active/running扩称为业务健康。

## 隔离与入口

新目录为/home/ubuntu/.local/ruukoto39/chaos-service-20261018T140635Z-93111a；未写live-profile或current源码，未改master、隧道、sshd、helper、策略或测试单元。根完成正常轮并释放unit后才执行故障轮，脚本先强校验count2及正常轮InvocationID；不符合则在模型或restart前停止。真实helper固定/usr/local/libexec/ruukoto39/ruukoto-service，policy固定/etc/ruukoto/services.json，sudo固定/usr/bin/sudo；helper与policy前后哈希一致，原值见evidence/before.json。目标名单只含专用测试服务。

占位授权与独立聊天均使用真实deepseek-flash，实际HTTP共2次，均200，上限4次；实际payload记录tool_choice:none，回答分别为A6_AUTH_RECEIVED、A6_INDEPENDENT_OK。来源输入明确授权本轮宿主只重启一次专用服务，模型只作只读回复。服务动作由可信p.service.request沿原sourceRequestId执行，不依赖模型随机选择工具。

## 故障窗口与恢复证明

| 阶段 | 独立观察与产品事实 |
| --- | --- |
| 受理 | operation requestId=a6-chaos-restart、taskId=35；原来源submission27/entry26；hostOpId=op_b8a37a4a26b788ea17bc305c |
| 外部效果已完成 | restart helper PID3463093于14:07:34.170Z close(code0,signal null)；结构回执exitCode0、launched=true，绑定同机器/hostOpId/opUnit；独立systemctl与计数读到新InvocationID/count3 |
| 结果未提交 | 复用openStorage.commit门，仅遇到ruukoto.service-operation-evidence/verb=restart时保存原字节候选并阻塞，未调用底层commit；门日志14:07:34.173Z |
| 真实强杀 | 14:07:34.199Z只向本次Harness子进程3463043发SIGKILL，14:07:34.218Z确认close(null,SIGKILL)；helper原调用此前已关闭 |
| 重开 | 原操作转effect_unknown/interrupted，无resolution、Task仍非终态；原source blocker返回a6-chaos-restart；没有第二次restart尝试，计数/InvocationID不再变化 |
| 独立工作 | 未知效果保留期间第二次真实模型聊天完成，原source blocker仍保持；没有pi.tool或模型toolCall |
| 产品核实 | p.service.resolve(ref,applied,独立效果证据)与p.service.recheckStop(ref)；两个stop-op回执均绑定原机器/hostOpId/opUnit，exited=true且launcherExited=true；Task终态completed，原source blocker变undefined |

效果历史保持effect_unknown/interrupted，人工resolution另记applied，不把缺失的原执行结果改写成executed。归档闭库只读SQLite核对：仅1个service-operation；原restart结果entry为0，inspect-op1、stop-op2；模型请求证据4条组成两个input/payload配对，两个输入均done。详情见sqlite-readonly-verification.json。

私有进程的spawn审计先记录每个helper尝试，再用O_EXCL阻止第二次restart；任何重发尝试都会把计数记为2并使断言红。本轮只观察到一次restart尝试和一次实际helper spawn，因此防重复护栏没有遮蔽产品重发。门之外不改产品控制流、参数或helper字节；停止核实均调用原产品API。

## 材料与适用范围

原字节归档evidence.tar.gz的SHA256为5a6c4bca0dab8c378ef0635430640b69d2976b702d6d2f3bd2c296c52e82970d；25项内容逐项哈希核对，另含artifact-manifest.json，共26个文件成员。remote以真实凭据的原文、URL编码与base64扫描全部归档成员，匹配0；凭据源从未复制或输出。archive-delivery.json和archive-secret-scan.json绑定传输与扫描。evidence/driver.mjs为可审计脚本，SHA256 d59bfd5440865a442c3c8cdaddb1e1824efa160460fa533f69d5f753efd3568a；evidence/runner-result.json保存实际命令与退出状态。

关键证据为evidence/events.jsonl、effect-before-kill.json、result-blocked.json、recovered-unknown.json、final.json及闭库profile。helper stdout包含执行前状态，执行后InvocationID以独立systemctl采样为准。脚本与原档案保留，原run-claimed及restart-issued文件使旧目录不能自动重放；后续新轮须另建档案并重新协调专用服务。

本轮证明真实Linux服务在“外部效果完成、durable结果未提交”窗口下的恢复、不重发、未知隔离与人工效果/原执行停止核实；使用可信宿主API，不替代模型自主服务操作、Telegram菜单、生产服务、真实IM或整项迁移验收。没有额外restart、其他服务目标、全仓检查或生产操作。
