# 工单 15 独立实现审查记录

本目录由独立审查上下文 next_slice 在审查结束后整理，仅写入 /tmp，未改共享工作区。这里是已完成工具响应的结论记录、输出摘录和实际执行的探针脚本；运行时未为归档重跑。完整原始输出没有在执行时重定向落盘，故本目录不声称持有完整原始日志。输出摘录从已完成工具响应转录，省略的输出没有补造。

审查对象为 apps/ruukoto/src/service-helper.ts、test/service-helper-transport.test.ts，另核对规格、15 工单及文档/笔记 diff。结论无未解决阻断。退出等待只证明原调用 child 与 stdio 关闭；没有承诺 systemd 操作单元、所有后代或后台 SIGKILL 后 detached helper 已停止。

执行环境由实际命令读取：node --version 为 v24.15.0；npm --version 为 11.12.1；uname -sr 为 Darwin 27.0.0。没有执行 sw_vers，不补写 macOS 产品版本。

实际执行命令与结果：

- npx tsx --test test/service-helper-transport.test.ts：6/6，通过，零跳过。
- npx tsx --test test/personal-services.test.ts test/personal-service-operations.test.ts test/78-linux-service-management.test.ts test/79-standing-permissions.test.ts：113/113，通过，零跳过。
- node --experimental-transform-types --input-type=module，通过 stdin 执行 async-events-probe.mjs 的相同脚本：2 个探针通过，验证 error/abort 在 close 前保持 pending、首因不可覆盖和 close 前尾部有界捕获。
- python3 通过 stdin 执行 negative-replay.py 的相同脚本，在独有临时副本复制 git show HEAD:apps/ruukoto/src/service-helper.ts 与当前新测试，再执行 node --experimental-transform-types --test <副本测试路径>：旧代码 3 项预期失败，3 项不受影响通过；finally 清理副本。失败分别是 aborted 尾部捕获缺失、timeout 提前 settled、spawn 监听窗口取消错变 timeout。
- 首次反例尝试使用 node --test，因构造器参数属性不支持 strip-only，在加载阶段报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX；不计入反证数量。修正为 Node 自带 --experimental-transform-types 后取得上述真实 3 红。
- git diff --check：退出码 0，无输出。
- shasum -a 256 apps/ruukoto/src/service-helper.ts test/service-helper-transport.test.ts：见 results.json。哈希来自审查结束时实际执行结果。

文档审查直接读取 docs/modules/agent-tools.md、docs/modules/personal-durable.md、既有服务检查笔记、新退出处理笔记、docs/development.md 与 pre-push-checks 的实际 diff。表述与实现一致，无阻断。方案审查时还亲跑 npm run verify-notes、npm run check:docs 与 git diff --check，全部通过；它们发生于方案阶段，不冒充最终全部文件的静态验收。

临时副本已 finally 删除，测试 fixture 的 after 钩子负责原进程组清理；新测试执行时全部正常退出，独立事件探针不启动 OS 子进程。归档目录保留供根上下文复制。

未独立执行 Linux、真实 systemd、真实模型/IM、全仓 check 或产品体验。Linux 与作者静态/构建结果由实施方证据持有。后台强杀遗留 helper 的持久身份与恢复核实不在本片，仍是子工具接入前提。
