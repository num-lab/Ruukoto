# 39：真实固定检查异常收尾

结论：本轮在Oracle新独立档案完成一个真实固定检查的异常收尾链。原字节helper实际完成systemctl show，在helper写出原状态前冻结；后台SIGKILL后仍保留同一原检查身份与工作占用；两次原stop-inspect回执exited=false。取消不会提前释放。最终在宿主按原身份结束该探针helper后，原正式stop-inspect取得exited=true，控制Task确认、工作中止、身份释放；再开没有新检查或模型请求。不是原390/427重放，没有restart、真实模型、IM或live写入。

远端唯一目录：/home/ubuntu/.local/ruukoto39/test-business/inspection-abnormal-20261018T154001Z-de7a6a01bc。当前源码649项前后逐字节匹配固定candidate-source；Node24.15.0、Linux arm64。helper SHA3f645f2ef05ff626f1def39ef1b0065f893385f96bdb0142c14aad864fb6433f和policy SHA83cbea028f2c5954d6ffe06d559a8c8862fa65e5bae02700743b3f5854c654da未变。测试服务始终MainPID3463107/InvocationID6220900834c14d8597e2979d513947bf/count3；没有服务操作工具装配，spawn审计restart计数0。

## 原身份与实际证明

- 本机拥有者输入entry24/submission25，子agent33/work39，子输入40/submission41，generation42，模型service_inspect工具Task49，唯一admission51。inspectionId为inspect_972a191f40b1cbb320d6b545。
- root私有claim uid0/mode0600/nlink1，原helper PID3507472/start410063336/PGID3507470，boot4599bbf3-085b-416f-8b8c-ffefbaf54968。真实show stdout候选294字节，SHA55f872e842bd7b1972bf94ec26154077e317fb72a04067f6db0506a682afa3b0；尚未向fd1写出，更未产生fd2结构reply。没有inspection结果entry，正符合中断窗口。
- gate detach后State=T/TracerPid=0，原组仅该helper；tracer3507471已退出。后台3507440在15:41:05.954Z被SIGKILL。闭库after-kill.sqlite保留Task49原身份、stopped=false、无结果。
- 重开生成stop entries52、53，原始stderr各唯一RUUKOTO_SERVICE_REPLY，与结构reply逐对象相等；两个exited=false均绑定原machine/inspectionId。取消已记录但agent33仍占work39，pending=[49]，stopVerified=false。
- 初始脚本在work.cancelRequested刚保存、工具取消尚未传播完成时请求控制，mayStop正确拒绝“原检查仍在执行”。原result.json/run.log保存exit1及堆栈，不能算产品缺陷或整例通过。finally用pidfd只结束本次仍T状态的原helper；这是宿主校准/清理动作，不能作为产品释放证明。
- 接续前只读SQL证tool49已terminal/abortRequested=true且原PID/组已退出；不新建profile/检查、不改entry。15:44:06重开，正式stop-inspect落entry55，exited=true及原字节reply可核；原inspection.stopped只依这份证明设true。正式requestInspectionStop(ref49/admission51)建立controlTask56并返回stopped。work39最终aborted、stopVerified=true，agent33.work清空，pending=[]；再次重开原记录仍在且无新调用。

## 仪器与边界

仅第一次inspect-op的spawn被测试插桩为“sudo -n /usr/bin/python3 gate.py run <本次目录> <原helper> inspect-op <原ID> <machine> ruukoto39-test.service”。Python以原/usr/local/bin/node运行完全相同helper字节，ptrace只在其write(fd1) syscall-entry检查原show缓冲内容。系统命令、目标服务、helper/策略及stop-inspect路径没有替身。正常信号传递保持；未detach时EXITKILL与finally只处理本次子进程，detach后明确核T/TracerPid0及tracer离组。

宿主结束helper使用os.pidfd_open，打开后复核原boot/start/PGID/完整argv，再signal.pidfd_send_signal(SIGKILL)。不按可复用PGID发信号，不停止服务或未知进程。最终/proc只读观察原helper、tracer、backend及本次目录命中均0；原root claim保留，不删除已提交记录。

覆盖范围仅“真实show已完成、helper原stdout/结构结果尚未返回时的孤儿检查”。不声称show自身阻塞、中断所有阶段、迟到新启动、真实IM检查菜单、完整A1–A12或生产接管。原52/53未退出到55退出及占用释放已足够补本次39指定的一个异常停止窗口；没有为初始驱动顺序错误新增第二个inspect。未引入生产代码改动。

## 原始包、审计与扫描

原始evidence.tar.gz为37文件成员、180755字节、SHA76636fcf7466306a64ef19a02bb2fd54b224b7259207ff3c91f8532f8d2eab1d。36项清单大小/SHA逐项一致。包含两个SQLite快照、闭库原profile、原脚本/失败及接续成功日志、事件与身份快照；原包不改写。

audit.mjs以DatabaseSync(readOnly=true)重建document delta，亲核after-kill/final quick_check、唯一admission、零inspect结果、stop52/53/55原字节匹配、原工作/控制终态、身份释放、两对input/payload及调用计数。初版审计误写document kind ruukoto.agents，已改为源码实际ruukoto.subagents；原TypeError日志保留，仅重跑只读审计，未再执行业务。

初始Mock模型HTTP仅2（拥有者授权答复、子检查意图），接续HTTP0；没有真实模型/IM。四份本轮实际凭据只在扫描内存读取，72种去重变体扫描37个解压成员及本地附属JSON均0；值、前缀、长度、凭据哈希均未输出/归档。扫描事实在four-credential-scan.json。

交付manifest.json列原包与附属审查/审计/扫描的哈希。作者的SQL交叉核对不冒称另一个上下文的独立实跑；方案曾由inspection_probe_review只读审查，最终原证据待根独立审阅。
