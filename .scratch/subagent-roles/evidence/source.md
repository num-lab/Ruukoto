# 子代理 shell 缺失的事实依据

核查日期：2026-10-14。源码基点：`ec45979fc94f9828cd902620752c059867b4de15`。以下为只读调查，不是新方案的运行验证。

## 用户提供的运行

原会话：`/Users/eitrous/.ruukoto-code-dev/agent-workflow-934ee66c/data/sessions/2026-10-14T10-15-08-603Z_c0a3423a-74c7-4fe7-aa4a-910fe91fcdd7.jsonl`。它是工作流 survey 步骤的子会话，task 为 `task_bb34d7800ebeb6d4e14808ce`，请求键为 `workflow:wfrun_82b58b41f9e046133765d41e:survey:1`。SQLite 只读核查为 access_mode=full_access、plan_mode=0；步骤参数只有 request/output，没有 mode。

该任务首次模型调用的 prompt 快照为同实例 `data/artifacts/art_e4a96ece6f7dcb7a02f91521.bin`。发送前记录的工具包括 read、http_request、read_artifact、todo_write、history_search、history_read、memory_list、memory_read、memory_save、memory_revoke、web_search、skill，没有 bash。此证据来自 SDK 委托发送函数前的快照，不声称是适配器转换后的 HTTP 原文。

会话第 5 行请求用 bash 调查目录，第 7 行 read 返回“目标是目录，无正文可读”。实际 530 次工具调用中 read 488 次，history_search 34 次，read_artifact 4 次，history_read 3 次，skill 1 次，无 bash 调用；末尾 aborted，任务 canceled、运行 owner_cancel。不能把没有 shell 调用误写成 shell 执行遭权限拒绝，也不把模型持续猜路径扩成另一项已授权功能。

## 现行实现

| 事实 | 入口 |
| --- | --- |
| 普通委派 mode 默认 analyze，只有 modify 有 bash | packages/agent/src/subagent-tools.ts、tool-availability.ts |
| 工作流默认 analyze；无写入目标时删除 edit/write/bash/request_file_access；verify 专用画像 | packages/runtime/src/workflows.ts、workflow-steps.ts；packages/agent/src/tool-availability.ts |
| 普通与工作流子任务沿发起来源访问模式；工具模式与 full_access 独立 | packages/runtime/src/subagents.ts、workflows.ts |
| readScope 只约束 read，其他写入能力靠不装配工具封住 | packages/agent/src/tool-worker/worker.ts 的 readScope 处理 |
| 执行目录和占用取 writeTarget，否则为子会话目录；加 bash 不自动占住来源目录 | packages/core/src/worktree.ts；packages/runtime/src/runtime.ts |
| 普通工作副本默认 HEAD；freeze 用 git add -N --all，不能直接对原工作区调用 | packages/runtime/src/work-copy.ts；test/83-subagent-worktrees.test.ts、test/110-workflow-workcopy.test.ts |
| 工作流来源能力能使用个人业务与 MCP，普通委派尚无相同来源接线 | packages/agent/src/driver.ts；packages/runtime/src/runtime.ts |
| agentDir 是受限执行保护根，但 full_access 使用当前账户且无该隔离 | packages/agent/src/execution/native.ts、launchers.ts |

[工作流 10](../../agent-workflow/issues/10-agent-wait.md)已明确把 shell 问题留作独立后续；[08](../../agent-workflow/issues/08-workflow-sidebar.md)同样已由拥有者验收。两单 resolved 保持；[11](../../agent-workflow/issues/11-experience-acceptance.md)仍负责交互联合验收。新方案的改变对象是默认能力与角色/执行契约，不把旧验收改写成新方案已经通过。

未修改开发实例、数据库、会话或产物；未启动真实模型、IM 外发或应用测试。运行证据直接覆盖这个工作流步骤，普通委派结论来自现行源码。
