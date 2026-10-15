# 14 冷重连历史分页时序

原 Linux full 在 test/14-tui-app.test.ts:615 的后续48KiB请求即时断言失败，正文完整恢复断言已通过；本机原窄例1/1通过，分别记录，不能将本机原绿冒充原红。

startApp只等ControlConnection.online，不等待loadHistory/restoreEventFlow完毕。read_history默认把单条正文截到16KiB（core/history.ts:413），所以本例大于48KiB的assistant条目必为truncated；readTaskFlow:1684的loaded集合排除它。readTaskFlow先逐页应用全部output_fragment和output_entry，并刷新显示；EventFlow.ts:327将有history身份的流段标为非streaming，完整delta已可重建完整唯一正文。readTaskFlow:1695在全部事件页结束后才loadEntry；app.ts:1612等首个48KiB应答后，1622才发offset>0后页请求。因此正文完整的predicate并不是“分页请求已发”的同步点。若其他并发loadEntry先完成，其后页请求也已被相同request wrapper记录；不存在需要删除本例分页保障的合法分支。

确定性诊断仅临时扩展现有startApp request wrapper，真实发送offset0请求、暂扣其返回应答。待原正文完整/唯一predicate成立且首个页请求已记录后，打印实况：fullBodyRecovered=true、uniqueAnswers=1、firstPageRequested=true、laterPageRequestedBeforeRelease=false。释放门控后执行旧立即断言，同条件确定失败。相同门控只替换为waitFor时通过，全部后续UTF8/完整/唯一/滚动断言仍执行。探针原/新源码和红绿日志均保留，无固定sleep、无生产改动。

最终补丁完全去掉临时门控，只把原requests.some立即assert改成waitFor原同一精确条件：read_history_entry、offset>0、length===48*1024；沿原waitFor默认15秒，不新增超时、不降低条件。最终无门控窄例1/1通过，单文件eslint通过。生产160文件哈希不变，未调用真实模型或外部平台。
