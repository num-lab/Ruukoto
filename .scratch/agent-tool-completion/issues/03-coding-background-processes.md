# Coding 会话后台进程、目录占用与停止核实

Status: needs-info

## 目标与边界

交付[共享规格第3节](../spec.md#3-后台进程)。拥有者确认跨消息保留，并接受首版先停后台再改同目录代码；不改为同会话绕过写占用。已有[后台提案](../../../.agents/notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)由本工单细化，未落地。首版只完全访问拥有者来源，不做PTY、自动重启或进程接管。

## 方案

1. core增加独立执行记录和可区分持有者的占用；状态、启动认领、交接、停止屏障和事件在事务内。endTask、失败/取消、目录冲突、重启及离线导入都核对新记录，不以终态Task释放独立占用。
2. Runtime持有会话后台管理，启动/停止串行认领；agent提供四工具及来源核实。先核实原Task临时worker停止，再在事务内无空窗转交占用、保存参考快照和当前轮观测阶段，随后收窄工具并launch；失败按共享规格保留或有证明地释放。独立worker复用现有输出协议与低层launcher，不从当前Task的worker摘PID。
3. Linux复用原scope/invocation身份；macOS补持久监督身份及后代停止回执。输出预算、短写/磁盘失败、管道继承、启动崩溃窗口和平台身份换代进入同一真实停止设计。平台证据不足不得降级交付。
4. 当前轮交接即进入内部对话，扩展Runtime.conversationAdmitted/initialPhase和参考提供者，使从未agent_wait的新会话也能接纳下一轮；同时改Driver的browser发送前resourcePhase限定、装配和调用门。只开放后台观测/停止、ask_user和符合来源的完全访问browser，禁止普通worker/MCP和目录访问；重取资源时明确报告后台占用冲突。
5. control/view/TUI/Desktop新增本会话后台清单、日志、停止和“结束本会话后台”；原始ID由程序管理。关闭屏障覆盖已接纳但未交接启动；存档和客户端断开保留原语义。应用关闭/恢复收齐停止，核实失败保留占用和可见状态。
6. 同步core/runtime/agent-tools/execution/control/view/tui/desktop、usage/development和所改入口的README/pre-push；实施时更新笔记状态及锚点。

## 进展与交接

- 当前角色：方案者；revision2及专项复核通过，跨轮、先停后改边界已经拥有者确认。
- 下一角色：拥有者审阅拟定的完全访问、观测阶段及关闭入口；实施先证明两平台身份/停止，再接工具与客户端。
- 当前内容：当前基点与未提交范围见[源码调查](../evidence/investigation.md)，审查对象见[快照](../evidence/plan-review.md)。
- 阻塞：实现前须完成真实平台启动身份与停止原型验证；原型不得调用模型或外部业务服务。方案本身不以平台支持已经成立为前提。

## 验收与证据

新增`test/background-processes.test.ts`及`test/background-processes-recovery.test.ts`（拟新增）：一次启动、当前轮启动后立即edit被拒、占用无空窗交接与失败、全新且无agent_wait历史的会话跨两轮查停/浏览、状态历史有界分页、继承管道后代、日志限额、取消与启动/交接/关闭竞争、重复操作及崩溃窗口零重放、目录替换、原身份变化不误杀。进程退出码与业务效果分别断言。

真实HTTP服务完成启动→下一工具browser访问→下一拥有者轮查询→停止→写工具重新取得目录；另证明后台活着时同会话/其他会话/子工作均不能写，agent_wait不能放掉后台占用或无限互等。受限新消息不能继承原完全访问浏览器资格，默认模式变化不伪造撤权。

扩展`test/100-worker-stop.test.ts`、`test/101-native-execution.test.ts`、`test/101-native-macos-helper.test.ts`、`test/native-linux-identity.test.ts`、`test/125-agent-wait-resource.test.ts`及实际涉及的62/66/UI用例。macOS本机与Linux ssh tx分别执行真实身份、强杀/重启、后代和停止探针；合成服务离线，不冒充真实模型或业务效果验收。

实施检查为`npm run build:worker`、`npm run check:static`及实际受影响的窄测；跨端协议/制品变动加对应产品入口测试。工程验收与产品验收均待验证，真实模型/浏览器/客户端分别列缺口；方案审查见[审查记录](../evidence/plan-review.md)。

## Comments

2026-10-21：拥有者明确接受首版后台运行时先停后改；窗口关闭/存档不作为停止证明，“结束本会话后台”提供显式关闭动作。
