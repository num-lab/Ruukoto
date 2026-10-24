# PTY 阶段同步候选独立审查

结论：v2 diff 未发现动作、行为断言或期限被放宽，无阻断项。同一12秒启动扰动下通过真实Linux目标验证，随后无延迟完整4项全部通过；我已独立重读两份原PtyResult并逐项核对保留的分段与终端恢复断言。

原始15 SHA256为ae688ea6e4c32b3d247f11cecdcc5486e9b19d17aa3308f7fdcd6f388634eeee。v2候选为9bc371a8ddedc1a2239333c665e86fd85ce5303e938e720c9c5dd0e83984b8ba，patch为2412e8fde77da35780d14ee56e2159c8092c1adf4590989e82b9c42b1f132f8e。

## Diff 核对

亲自解析新旧工作流inputs数组，21个动作的字符串字节、尺寸和顺序完全相同。初始140×30保持，两次resize仍为动作9的70×22与动作13的140×30。原expect列表、40秒驱动期限、60秒测试期限及结果断言均逐字一致；segments 9/10/13/14/18/19仍对应原先的PgDn、缩窄、窄屏Tab返回、恢复宽屏、Esc详情与Esc根列表。所有后台工作流、待回答、仅两次模型调用、终端恢复与宽窄同时显示断言均保留。

新画面条件只查segments[-1]；每次发动作前追加空segment，所以历史画面不能推进。各gate均非空，前一步输入回显不能满足下一gate；模型回答使用CHAT-OK前缀，查询等待同时要求标题和选项，焦点使用●/○。原数值输入条件保留，因此另外3项原路径仍需完整文件验证。

## 实验与候选修正

原绝对时间链加唯一一次12秒启动延迟：TUI正常退出0但expectSeen为0/6，原断言失败，完整33.996秒；没有超时或遗留。该反例保留原失败，不增加期限或做重试。12秒是人为构造的唯一扰动，只证明固定时序能因此错位；没有历史进程时间线证据，不声称旧CI或本机原失败实际上经历了12秒启动延迟，也不据本实验替代其具体失败堆栈。

v1首次画面链在相同扰动下已完成前20个动作和5/6期望，但最后等不到“连接：在线”。raw结果表明末次Esc已回到普通聊天；Pi终端采用增量重绘，未变的连接行不再输出。v1失败证据全部保留，没有计作通过。

v2仅将最后一门换为同一动作实际新重绘的CHAT-OK:宽屏聊天与右移后的mock/mock-model。亲自检查raw segment20满足二者，前一root列表segment19不能满足。该修正只改变等待的可观察文字，不改变任何按键、退出方法、断言或期限。

Linux v2同一12秒扰动目标验证：1/1通过，TUI exit0、6/6期望、22segments，全部原断言通过；body16.441秒、Node19.704秒、完整19.930秒，无超时或残留。Linux agent的额外观测仅在JSON解析后、错误判断前落盘原PtyResult，未改动作或断言，前后hash另存observation-manifest.json。

## 证据

本目录independent-action-audit.json记录逐项审计；last-gate-evidence.json记录v1最后一门的实际输出证据。Linux原红、v1失败、v2绿及完整文件结果已由linux_diagnosis按明确普通文件拷回。不要递归复制带node_modules符号链接的探针目录。

## 已应用版本

已亲自核对主工作区test/15-tui-pty.test.ts与受审v2候选的完整差异，仅多一行文件头Note锚点；身份与差异记录见applied-main-identity.json和applied-main-diff.patch。root报告本机当前冻结组合中的工作流PTY目标已通过，主体1.523秒；本审查未另行启动本机native或PTY，也不把该目标通过写成完整组合已通过。

## 完整4项与证据关联

Linux Node24无延迟完整文件4/4通过、0失败/跳过/取消，Node51.789秒、监督52.022秒；工作流主体4.183秒。监督结果exit0、timeout=false、remaining={}，保留了原数值输入路径的compact、80×24中文/流式与Ctrl+C后台继续用例。

- 原版同12秒扰动红：`../pty-fixture-gates/run-original-delayed/{output.log,result.json}` 与 `../pty-fixture-gates/original-delayed.result.json`。
- v1最后一门失败及原始分段：`../pty-fixture-gates/run-fixed-delayed/{output.log,result.json}`、`../pty-fixture-gates/run-fixed-delayed-observed/`、`../pty-fixture-gates/fixed-delayed-observed-raw.result.json`。
- v2同扰动目标绿：`../pty-fixture-gates-v2/run-fixed-delayed/{output.log,result.json}` 与 `../pty-fixture-gates-v2/fixed-delayed.result.json`。
- v2无延迟整4项绿：`../pty-fixture-gates-v2/run-fixed-full/{output.log,result.json}` 与 `../pty-fixture-gates-v2/fixed.result.json`。
- 本人独立重读原分段后的核对结果：`independent-result-audit.json`。

两份v2原PtyResult均为exit0、6/6期望、22segments；本人逐项重核PgDn正文、窄屏保留日志且隐藏聊天标题、窄屏Tab返回、宽屏同时呈现聊天和日志、两级Esc导航、最终聊天重排标记与alt-screen离开。后台运行只有一次、说明与空业务参数正确、waiting/pending保持、仅两次模型调用等原数据库断言由完整真实测试执行并通过，未以终端输出替代。

上述是独立定向与完整15文件验证，不写入此前已结束的冻结全量。后续Node22、83或SSE增量另有范围与证据，不包含在本报告结果内。
