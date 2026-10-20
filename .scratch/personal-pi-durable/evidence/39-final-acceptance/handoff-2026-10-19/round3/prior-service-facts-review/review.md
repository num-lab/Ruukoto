# 服务事实投影补充核实：独立复审

结论：当前源码无未解决阻断。此前未知callId/伪造toolResult实际进入HTTP的反例已由当前未匹配结果逐项核实修复；没有改服务执行、批准消费、取消、结果未知或原停止状态机。

新增fallback只遍历当前conversation的terminal pi.tool，沿真实outcome.entryId、pi.tool-result/byTaskId、原assistant及service_restart调用核实，并逐对象匹配实际消息；没有service op的合法接纳前错误可保留原结果，不注入业务事实。最终匹配计数必须齐，未知引用仍缺持久映射即在provider前拒绝。

独立亲跑当前入库5例共5/5、0skip、exit0、约2.43秒：取消复用、替换已知result、成对移出旧调用后重复callId、歧义重复调用、未知引用拒绝。三条失链/歧义例均经过正式Harness和实际Mock HTTP计数，零新增HTTP；不是仅纯函数throw。

命令：node --import tsx --test --test-name-pattern='子服务：取消后复用从实际请求|子服务：上下文移出原调用后|子服务：原结果被模型编辑|子服务：重复工具调用使服务结果|子服务：未知调用引用的伪造' test/personal-service-operations.test.ts

另在本目录proof.test.ts亲跑两个独立正/反边界：接纳前schema拒绝同身份两轮相同callId1/1通过（约1.64秒），实际四次子HTTP及四份持久payload，无service op、零restart，原历史entry逐对象不变且不注入service-facts；仅移出旧result保留assistant产生missing_result1/1通过（约1.99秒），新工作失败、零HTTP且原历史不变。这两轮分别执行，没有冒称一次广组结果。

命令：node --import tsx --test --test-name-pattern='独立补充：接纳前schema' /tmp/ruukoto39-service-facts-final-review/proof.test.ts

命令：node --import tsx --test --test-name-pattern='独立补充：仅移出旧result' /tmp/ruukoto39-service-facts-final-review/proof.test.ts

missing_result没有需要新增弱豁免的正常路径：当前durable的selectCut只以user/assistant为候选且避免把调用和其结果分开，summaryPrompt把历史工具串序列化成user文本；原tool终态与结果entry同commit提交。当前部分结果移出反例属于不可核实输入，拒绝符合笔记。成对移出以及正常取消复用路径已实跑。

personalServiceResult使用已有unresolved，未消费取消requiresVerification=false，consumed/started仍等待原操作，unknown须效果/原停止双事实齐才false；verification分支解释这一区别，launcherStopped=false不自行宣称整个工作仍被占用。工具/结果/summary共用投影，actual input/payload落盘，原记录不覆盖。note与personal-durable说明一致。

源码SHA见source-manifest.json。只写本临时目录，未写共享工作区；未跑完整static/整文件或全仓；未操作真实模型、私人IM、QQ、服务/生产或凭据。真实QQ新委托及图片结果不由本次离线审核关闭。
