# 39 报告正文发送状态误述：独立诊断

审计基线 b1e975437f4cd3ca8084a8b07e451f19ba80ba17；只读产品源码。真实模型 DeepSeek/deepseek-flash，max_output_tokens=1024；平台为回环Telegram替身，未发任何真实IM。

## 实际结果

原始运行目录 `/tmp/ruukoto39-real-report-2026-10-18T125357-014Z`；14次真实模型HTTP、28条成对请求记录。先完成本机短委托local报告，正常关闭/重开后复用同一子身份33，新委托85的子工作94产生length截断，最终报告107/answer132只发送一次至假TG owner456/message11，平台回执1001；第二次重开没有新增模型调用或平台发送。原SQLite保留，1400832字节，SHA256 ecce8645be6a4887c637c988853cfe037141f4632976ca03b0fffd426fe151cc；密钥原文/base64/URI三种变体扫描零命中。

结构事实通过：身份复用、partial=true、报告明确截断且没有旧工作marker、原入口唯一发送、终态重启不重放。但报告正文写：

> 其他：最终汇总报告仍在生成中（delivery=waiting），属正常流程，无需另行处理；本委托之外的历史未读证据本轮未核实，不影响上述结论。

宿主最终事实为sent。第一版探针仅匹配“仅本机/未外发”而给出passed=true；原result.json保留未改。独立红复核 `independent-red-review.json` 明确 effectiveAcceptancePassed=false/code=report_body_stale_delivery_state；不能把原passed作为验收结论。现在 `/tmp/ruukoto39-real-report-probe.mts` 已补generating/waiting红能力自测，初次实际执行脚本保留在目录 `original-executed-probe.mts`。

## 假设与证据

1. H1：报告生成时从progress读到它自身的waiting/running，复制为最终正文。真实tool call entry120=progress(delegation85)，toolResult entry122明确含report:{delivery:waiting,state:running}及顶层state:reporting，最后payload entry131包含该结果，answer132复述delivery=waiting。该输入来源已确认；单次真实模型不能证明它是唯一影响。
2. H2：第一份local报告中的同一句污染后续报告。最后payload131确实保留第一份旧报告，因此不能完全排除放大作用；但无历史/无重启的确定性mock最小链已复现输入→正文路径，旧历史不是该坏投影的必要条件。
3. H3：宿主提交/发送时固定了错误状态或发错正文。实际report107最终sent、platformMessageId1001、body.text与保存reply/answer相符，唯一发送与重开不重发均成立；该解释被本次事实排除。

## 最小红循环

`RUN_MODEL_CHECK=0 node --import tsx /tmp/ruukoto39-real-report-progress-red.mts`：当前exit1，5次loopback mock模型请求，单个新本机委托，无历史/重启/IM。假模型在汇总时调用progress；收到report.delivery=waiting就复述“仍在生成中”。最终报告delivery=local，断言正文不应含waiting失败。日志 `-progress-red-final.log`，结果目录 `/tmp/ruukoto39-real-report-progress-red-pzJtjJ`。

两条等价读取路径也已实际红：

- `PROBE_ACTION=delegations ... /tmp/ruukoto39-real-report-read-paths-red.mts`：list的当前委托项同样带report/state，exit1；日志 `/tmp/ruukoto39-real-report-delegations-red.log`。
- `PROBE_ACTION=report_result ... /tmp/ruukoto39-real-report-read-paths-red.mts`：自报告返回delivery:waiting/state:running，exit1；日志 `/tmp/ruukoto39-real-report-report_result-red.log`。

合并原文 `/tmp/ruukoto39-real-report-read-paths-red-results.json`。这两动作没有出现在14次真实模型链里，不能声称是本次实际触发；它们证明只删progress并不能封住同类输入路径。

## 最小修复边界建议

J5只从模型progress结果删report与顶层state（保留成员state）能覆盖实际触发；不要改personalDelegationProgress本体，否则CLI/IM控制与宿主真实查询损失状态。模型delegations各委托项也去掉report/state，否则同快照仍可经列表进入模型。普通拥有者仍可用report_result明确查询报告与发送状态。

生成报告时的同report自查询必须另有窄守卫；已有report.submissionId与LiveDoc.run.inputs即可核实，无需新状态、新持久格式或解析requestId字符串。该守卫只应用模型工具路径，不能让同时发生的人类CLI查询也被抹掉。已完成的旧报告/普通拥有者查询仍沿真实状态返回。若只加强提示，当前requestPersonalReport已明文要求“正文只写业务结果与必要下一步，不把生成中的报告发送状态当作待办”，真实模型仍复述；不建议再叠同义提示作为唯一修复。不要正则改写模型原文，也不要提前编造sent。

确定性回归应检查真实汇总provider请求里progress/delegations没有自身report/state，report_result自查询拿不到可误作最终事实的waiting快照；正常拥有者report_result和CLI仍返回真实delivery/state。修复后先跑这些秒级红循环，再原样重跑有限真实模型链，新的源码指纹与原错误现场分开存。

未修改产品代码；未做崩溃恢复或真实IM；一次真模型结果不证明统计可靠性。
