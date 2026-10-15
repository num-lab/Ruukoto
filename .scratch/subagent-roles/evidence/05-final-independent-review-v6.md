# 05 最终独立审查 v6 补充

v6测试夹具修补本身无独立审查阻断，未修改生产。固定65项输入、30个unique修复文件与主区一致，30个修复文件与独立私有workspace解析副本同字节；主区620项冻结源码v6全部匹配。v5仅test/14-tui-app.test.ts一行摘要被本版取代，另64项保持；原v1–v5清单、报告和归档不覆盖。

第二轮Linux v4完整检查的252用例确切失败栈尚未回收，本补充只证明一项真实可重现夹具交错及修补强度，不预先认定该次完整失败原因或宣布联合工程通过。原122校准用例已在正式完整运行中通过，仍不等于完整命令通过。

## 实际反例与被否同步

独立有限get_task门控：second-app真正获取owner详情后，延迟交给调用方；原测试手工清flow/tasks后释放，真实internal loadEntry后原users=[]断言失败，实际仅合法“启动工作”，internalVisible=false，0/1、exit1。显式再开loadHistory并await在此gate下可绿，完整原源码/差异/上下文已单独保存。

再独立执行作者提供的旧list_tasks门控反例，新的显式loadHistory已返回、旧list_tasks仍被控制，手工重置后释放旧响应，原users=[]仍被合法owner污染；actual explicitHistoryJoinReturnedWhileOldListHeld=true、internalVisible=false，0/1、0跳过、exit1。该负例说明新开一轮加载不是对所有既有顶层加载的排空合同，不以poll flowRequests或sleep替代正确隔离；人工门控证明可能交错，不冒称原完整运行已有这条时间线。

## 最小可靠隔离与断言强度

原again继续承担真实实时/冷重连、分页、↑、sticky和搜索路径。只把故意“无Task元数据、单条先到”子场景换成new ViewState及未start的独立TuiApp；使用原已认证connection实际loadEntry，随后安装真实Runtime返回的报告Task详情，不用state shortcut替换读取。该App不接后台回调、不启动/不quit共享连接，故原again的在途恢复只修改原投影。

新投影选中真实sessionId；读取前后tasks.size均为0；原entryId且inputPurpose=internal_report的实际history记录必须存在，防读取失败被吞后空绿；两次users=[]保持，读取和详情后到的实际当前render均不得出现内部marker。原again的实时/历史、↑、置顶、搜索和唯一正文断言保留；分页后另要求实际owner历史条目存在，防仅缓存Task投影假绿。没有改可信分类、来源权限、产品超时、生产或默认并发。

## 本上下文亲自执行

独立私有副本以v5 runtime执行，先对作者无raw存在guard候选验证，再撤去候选应用root最终补丁。最终无门控正式文件同时运行两个受影响窄例（252可见性与原615长文分页）：2/2、0失败/跳过/取消、exit0、3337.371458ms。最终raw guard亦加入相同旧list_tasks gate独立演练，1/1、0跳过、exit0、1434.532708ms，afterResetUsers=[]、internalVisible=false，原again外层全部断言通过。旧list_tasks gate红、新独立投影同gate绿及最终去gate原日志/源码分开保留，不把候选92f版本冒称root最终版本。

root最终test14 SHA256=dd57159823efc0b6febc197f2214097f65468e0c77d495225d16694898b4814b；补丁SHA256=7ea53f970b3a81ea022710caca6976f5251d3cb220996929c4aa553d7d28b38c。源码冻结v6清单SHA256=8e4c67ee72fcada1910073e6a5063341cf9fbd515f4293134ed1332a102ae0fa。其余v5生产不变，runtime仍99b21d653e9d1d6dda57ef0325343f4ada3f437a28e9619a7bb81540caaaabae，模型仍为159个同字节生产输入加一项已独立机械审查的runtime差异。

## 尚待实际结果

须回读第二轮full最终实际栈、全部退出统计及归档；若只有此夹具失败且原实际栈匹配，再以最终静态、test14整文件双平台和Linux v5来源/等待恢复30例完成受影响面复验。依据05工单“一次完整check”、pre-push:12及workflow:44/56，可按实质变化范围复核，未要求机械第三次全量；同时始终保留两次Linux full的实际失败，绝不能把定向拼成单次全量通过。若发现内部真实泄露、额外未解释失败或跨面新行为，须重新定验证范围。

前序R1–R14、目标与来源修复、runtime标准修补及外部/产品边界继续沿原报告有效范围适用。此附录不授予外部MCP/IM或拥有者体验通过，也不改变工单状态。
