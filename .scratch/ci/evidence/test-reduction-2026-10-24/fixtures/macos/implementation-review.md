# macOS 原生身份夹具：独立实现审查

对象为主工作区 `test/native-macos-identity.test.ts` 的就绪文件与失败清理改动，文件 SHA-256 `1c4ba2ce310c2d3b8827554f84aa04bab0eb55fd1ef07a9c88e5ffd944bea8f6`。已直接读取实际 diff、完整五场景夹具、原生产 C 的 sample/stop_worker/finish_output/status_message，以及 `/tmp/ruukoto-macos-identity-fixture-fix/diagnosis.md` 和对应控制实验。主工作区只读；完整本机检查正在执行，本轮没有编译或运行任何 native 用例。

## 结论

没有阻断发现。修改只发生在测试生成的 C wrapper，不改变生产监督器、身份判断、信号范围、停止预算或未知孤儿分类。就绪 PID 在私有临时文件写完并关闭后，再 rename 为原 ready 路径；父进程不会再因只看见文件名而读到尚未写入的空 PID。open/写入/关闭/rename 失败均使该夹具失败，不伪造就绪。

正常路径仍先执行原 stop_worker，核实 finish_output，并由 status_message 写出停止证据；随后真实调用 identity(orphan) 计算并输出 alive；这两份记录完成后才进入 cleanup 发布 release。JS 断言本来就在 ChildProcess close 之后执行，它检查的是上述清理前已经生成的记录，不能把释放后退出当成生产停止证明。

五类原断言全部未改：ordinary-double-fork 的 reaped=true、orphan.alive=false；未知脱离但主动关闭输出管道的 reaped=true、alive=true；继承管道的脱离孤儿 reaped=false、alive=true、output_pipe_not_closed；两个已知后代短祖先/进入未见组的场景均 reaped=false、alive=true、unknown_new_orphan。release 不会重新调用 stop_worker、覆盖 stopped 消息或重新采样 alive，所以无法把原失败转换成预期结果。

## 清理范围与失败可见性

release 路径固定在该次 fixture 的 realpath(mkdtemp) 工作目录内。新增的 worker、go、group、joined 等待只观察同一个私有文件，不调用 kill、killpg 或按名称/用户遍历进程。最终 waitpid 只接收本次 fork 返回的正 worker_pid；fork 未成功时不会以负 PID 等待任意进程。生产 stop_worker 原本的身份核实与原子信号调用未改，它发生在正常停止验证阶段，不能与新增失败 cleanup 混称。

fork 后原 return3/4/5/8 改为先保存 result 再跳 cleanup；随后发布释放文件、等待直属 worker，原错误码返回 Node。早退不会走正常 stopped/orphan 消息生成，JS 的 exit==0 仍会失败。worker 原无限 pause 改为等待 release，只影响协作清理；正常 stop_worker 发信号前不存在 release，不能让根进程提前自行退出。known 模式在等待 go/group/joined 时也能响应 release，避免较早失败留下继承管道。fork 前 return2 没有已创建后代，不需要这条释放路径。

## 证据核对

审查读取而未重跑以下证据：就绪发布的控制实验在 open 和写 PID 间加入相同250ms停顿，原版退出4且退出后400ms仍无close，原子发布版退出0且正常close，原 stopped.reaped=true/orphan.alive=false保持。正常五场景 green.log 为6/6（含父项），Node报告duration_ms=9312.826708。early-exit-probe.mjs 对每个mode强制进入3/4/5，并对两个known模式进入8，共17项；results.json逐项保留相应非零退出码、released=true，close在约0.35–0.58秒内完成，status为空，没有伪造正常停止报告。

这些材料证明当前夹具修复和注入失败的清理行为，不证明所有可能OS错误或最终全套已通过。现场原挂住轮的手动回收由另一执行者按已核实进程身份完成，必须继续记为失败诊断；本审查没有触碰任何现场或其他scope进程。

本轮 `git diff --check -- test/native-macos-identity.test.ts` 通过。测试精简笔记当前区分清理与生产停止证明，与实际顺序一致。完整macOS检查、Linux组合及原四格CI的最终结果仍由各自证据持有，不能由本次静态审查替代。
