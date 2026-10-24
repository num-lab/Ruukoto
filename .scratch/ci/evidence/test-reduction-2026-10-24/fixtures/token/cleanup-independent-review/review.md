# Entry 清理与诊断补丁独立审查

结论：当前entry的分阶段清理与cleanup-diagnostic.patch没有阻断项。审查通过不代替root当前固定快照的完整检查。

核对了当前主文件的EntryCleanup/cleanupFor与探针中的实现逐字一致；候选仅增加stderr诊断，后续AggregateError、阶段顺序与错误收集不变。记录的主文件和patch SHA见source-identity.json。children、models、directories顺序释放，各组内逆序；单项失败只被收集，后续资源仍释放，最后重新抛出聚合错误。

亲自顺序执行原实现与加诊断候选的普通Node child + mock HTTP多失败探针，没有启动本机native或PTY。两者均故意先让body失败，再注入最早child清理项失败、model关闭后失败和directory删除失败。阶段记录都显示后续真实child关闭、model关闭与directory清理尝试依次发生。两者测试都按预期自然退出1。

原实现的Node test报告只保留body错误，三个after错误均不见；候选stderr用[ruukoto:test]明确列出三者，同时Node报告仍保留原body错误。因此该补丁补足被test runner覆盖的清理诊断，不将失败改记成功。

运行结束后独立核实两个探针的child PID均已退出、mock端口均ECONNREFUSED。故意注入的rm失败按设计留下目录；先记录证据，再仅删除这两次探针拥有的精确临时目录，最终无进程、监听或夹具目录遗留。全部证据见baseline.log、candidate.log、对应events.jsonl与verified.json。

真实bin serve已ready后body失败的清理路径已由Linux agent另行运行并通过外部验证：原PID正常退出0、mock监听关闭、档案目录删除，事件顺序一致；证据位于/tmp/ruukoto-reduce-linux-evidence/issue04-real-bin-cleanup。
